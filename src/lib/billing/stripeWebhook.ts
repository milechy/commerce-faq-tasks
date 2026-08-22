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
      const claimed = await _claimWebhookEvent(event, db);
      if (!claimed) {
        // 完了済み、または他リクエストが処理中。どちらも副作用を実行してはならない。
        logger.info({ eventId: event.id, eventType: event.type }, '[webhook] event not claimed (completed or in progress), skipped');
        res.json({ received: true, duplicate: true });
        return;
      }
      await _handleStripeEvent(event, db, logger);
      await _markWebhookEventCompleted(event, db);
      res.json({ received: true });
    } catch (err) {
      // completed_at を更新しないため、claim が STALE_CLAIM_MINUTES 経過した後の
      // Stripe再送で再試行される。
      logger.error({ err, eventType: event.type }, '[webhook] event handling failed');
      res.status(500).json({ error: 'handler_error' });
    }
  };
}

/** claim をこの時間放置したら、処理中プロセスの異常終了とみなして再獲得を許可する。 */
const STALE_CLAIM_MINUTES = 15;

/**
 * このリクエストが event の処理権を獲得できたかを返す。
 *
 * 単一の条件付きUPSERTで判定するのが要点。INSERT成功/失敗を見てから別クエリで
 * 状態をSELECTする方式だと、同一イベントが並行到達したときに両方が「未完了だから
 * 再試行」と判断してハンドラを二重実行しうる（DB更新は WHERE 条件付きで冪等だが、
 * Slack通知は非冪等なので実害が出る）。
 *
 * 獲得できる = 次のいずれか
 *   - 初回受信（衝突せずINSERTできた）
 *   - 過去に受信済みだが未完了で、かつ前回の claim が STALE_CLAIM_MINUTES 以上前
 *     （＝処理中プロセスが落ちたとみなせる）
 * 獲得できない = 完了済み、または他リクエストが現在処理中。
 */
async function _claimWebhookEvent(event: any, db: any): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO stripe_webhook_events (event_id, event_type, claimed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (event_id) DO UPDATE
       SET claimed_at = NOW()
     WHERE stripe_webhook_events.completed_at IS NULL
       AND (stripe_webhook_events.claimed_at IS NULL
            OR stripe_webhook_events.claimed_at < NOW() - ($3 || ' minutes')::INTERVAL)
     RETURNING event_id`,
    [event.id, event.type, String(STALE_CLAIM_MINUTES)]
  );
  return (result.rowCount ?? 0) > 0;
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
