// src/lib/billing/stripeWebhook.ts
// Phase32: Stripe Webhook処理

import type pino from 'pino';
import type { Request, Response } from 'express';

function getStripeClient(): any {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not set');
  const Stripe = require('stripe');
  return new Stripe(secret, { apiVersion: '2024-06-20' });
}

/**
 * POST /v1/billing/webhook ハンドラファクトリ。
 *
 * ⚠️ このルートは express.raw({ type: 'application/json' }) を使うこと。
 *    Stripe 署名検証には raw body（Buffer）が必要。
 */
export function createStripeWebhookHandler(db: any, logger: pino.Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error('[webhook] STRIPE_WEBHOOK_SECRET not set');
      res.status(500).json({ error: 'webhook_not_configured' });
      return;
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      res.status(400).json({ error: 'missing_stripe_signature' });
      return;
    }

    let event: any;
    const stripe = getStripeClient();
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      logger.warn({ err }, '[webhook] signature verification failed');
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }

    try {
      const status = await _recordOrCheckWebhookEvent(event, db);
      if (status === 'done') {
        logger.info({ eventId: event.id, eventType: event.type }, '[webhook] duplicate event, already completed, skipped');
        res.json({ received: true, duplicate: true });
        return;
      }
      // 'new'（初回）または 'retry'（前回未完了 = ハンドラ失敗/処理中クラッシュ）は
      // どちらも副作用を実行する。'retry' はハンドラ内の各処理が個別に冪等
      // （UPDATE ... WHERE 条件一致のみ更新、Slack通知は再送の可能性を許容）である前提。
      await _handleStripeEvent(event, db, logger);
      await _markWebhookEventCompleted(event, db);
      res.json({ received: true });
    } catch (err) {
      // completed_at を更新しないため、Stripeの再送時は 'retry' として再試行される。
      logger.error({ err, eventType: event.type }, '[webhook] event handling failed');
      res.status(500).json({ error: 'handler_error' });
    }
  };
}

/**
 * event.id を stripe_webhook_events に記録し、処理方針を返す。
 * - 'new'   : 初回受信（ON CONFLICT に当たらず新規INSERTできた）
 * - 'retry' : 過去に受信済みだが completed_at が NULL＝前回ハンドラが失敗/未完了
 *             （record-before-handleのため、成功保証はINSERTではなくcompleted_atが持つ）
 * - 'done'  : 過去に受信済みかつ completed_at が設定済み＝ハンドラは最後まで成功した
 */
async function _recordOrCheckWebhookEvent(event: any, db: any): Promise<'new' | 'retry' | 'done'> {
  const insertResult = await db.query(
    `INSERT INTO stripe_webhook_events (event_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING`,
    [event.id, event.type]
  );
  if (insertResult.rowCount > 0) return 'new';

  const statusResult = await db.query(
    `SELECT completed_at FROM stripe_webhook_events WHERE event_id = $1`,
    [event.id]
  );
  return statusResult.rows[0]?.completed_at ? 'done' : 'retry';
}

/** ハンドラが最後まで成功した後にのみ呼ぶ。再送時の 'retry' 判定に使う。 */
async function _markWebhookEventCompleted(event: any, db: any): Promise<void> {
  await db.query(
    `UPDATE stripe_webhook_events SET completed_at = NOW() WHERE event_id = $1`,
    [event.id]
  );
}

async function _handleStripeEvent(event: any, db: any, logger: pino.Logger): Promise<void> {
  switch (event.type) {
    case 'invoice.payment_succeeded':
      await _handlePaymentSucceeded(event.data.object, db, logger);
      break;
    case 'invoice.payment_failed':
      await _handlePaymentFailed(event.data.object, db, logger);
      break;
    case 'customer.subscription.deleted':
      await _handleSubscriptionDeleted(event.data.object, db, logger);
      break;
    default:
      logger.debug({ eventType: event.type }, '[webhook] unhandled event type, ignored');
  }
}

async function _handlePaymentSucceeded(invoice: any, db: any, logger: pino.Logger): Promise<void> {
  const subscriptionId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id;

  if (!subscriptionId) {
    logger.warn({ invoiceId: invoice.id }, '[webhook] payment_succeeded: no subscription id');
    return;
  }

  const result = await db.query(
    `UPDATE usage_logs
     SET billing_status = 'paid'
     WHERE stripe_subscription_id = $1 AND billing_status = 'reported'`,
    [subscriptionId]
  );

  logger.info(
    { subscriptionId, updatedRows: result.rowCount, invoiceId: invoice.id },
    '[webhook] payment_succeeded: billing_status → paid'
  );
}

async function _handlePaymentFailed(invoice: any, db: any, logger: pino.Logger): Promise<void> {
  const subscriptionId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id;

  logger.warn(
    { invoiceId: invoice.id, subscriptionId, amountDue: invoice.amount_due },
    '[webhook] payment_failed'
  );

  await _sendSlackAlert(
    {
      type:           'payment_failed',
      subscriptionId: subscriptionId ?? 'unknown',
      invoiceId:      invoice.id,
      amountDue:      invoice.amount_due,
    },
    logger
  );
}

async function _handleSubscriptionDeleted(
  subscription: any,
  db: any,
  logger: pino.Logger
): Promise<void> {
  const subscriptionId = subscription.id as string;

  const result = await db.query(
    `UPDATE stripe_subscriptions
     SET is_active = false, updated_at = NOW()
     WHERE stripe_subscription_id = $1`,
    [subscriptionId]
  );

  logger.warn(
    { subscriptionId, updatedRows: result.rowCount },
    '[webhook] subscription.deleted: deactivated'
  );

  await _sendSlackAlert({ type: 'subscription_deleted', subscriptionId }, logger);
}

interface SlackAlertPayload {
  type: 'payment_failed' | 'subscription_deleted';
  subscriptionId: string;
  invoiceId?: string;
  amountDue?: number;
}

async function _sendSlackAlert(payload: SlackAlertPayload, logger: pino.Logger): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const text =
    payload.type === 'payment_failed'
      ? `⚠️ *課金エラー*: 支払い失敗 | subscription: ${payload.subscriptionId} | invoice: ${payload.invoiceId} | 金額: ${payload.amountDue}セント`
      : `🚨 *解約アラート*: サブスクリプション削除 | subscription: ${payload.subscriptionId}`;

  try {
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
  } catch (err) {
    logger.error({ err }, '[webhook] slack notification failed');
  }
}
