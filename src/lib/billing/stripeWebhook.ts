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
    case 'checkout.session.completed':
      await _handleCheckoutSessionCompleted(event.data.object, db, logger);
      break;
    default:
      logger.debug({ eventType: event.type }, '[webhook] unhandled event type, ignored');
  }
}

/**
 * PR-4(2026-08-25収益監査): invoice → tenant_id + 請求対象期間の解決。
 *
 * ★従来の実装が恒久 no-op だった理由★
 * 旧実装は `usage_logs.stripe_subscription_id` で突合していたが、この列への
 * 書き込みは usageTracker.ts の INSERT に一度も含まれておらず(リポジトリ全体で
 * 書き込み箇所が0件)、常に NULL だった。そのため `WHERE stripe_subscription_id = $1`
 * は常に0行しかヒットせず、billing_status は永久に 'reported' のまま滞留していた。
 * テストは mockDb.query に渡された SQL 文字列の一致だけを見ており、実DBでの
 * 行数を検証していなかったため、この no-op のまま緑が続いていた。
 *
 * ★是正: usage_logs に列を増やさず、既存の stripe_subscriptions から引く★
 * stripe_subscriptions は tenant_id と stripe_subscription_id を既に持つ
 * （stripeSync.ts の getSubscriptionItemId と同じテーブル）。invoice が持つ
 * 請求対象期間(period_start/period_end、Unixタイムスタンプ秒)と組み合わせれば、
 * usage_logs 側に新しい列を足さずに tenant_id + 期間で突合できる。
 */
async function _resolveTenantAndPeriod(
  invoice: any,
  db: any,
  logger: pino.Logger,
  eventType: string
): Promise<{ tenantId: string; periodStart: string; periodEnd: string; subscriptionId: string } | null> {
  const subscriptionId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id;

  if (!subscriptionId) {
    logger.warn({ invoiceId: invoice.id, eventType }, `[webhook] ${eventType}: no subscription id`);
    return null;
  }

  if (typeof invoice.period_start !== 'number' || typeof invoice.period_end !== 'number') {
    logger.warn(
      { subscriptionId, invoiceId: invoice.id, eventType },
      `[webhook] ${eventType}: invoice has no period_start/period_end, cannot map to usage_logs`
    );
    return null;
  }

  const subResult = await db.query(
    `SELECT tenant_id FROM stripe_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
    [subscriptionId]
  );
  const tenantId = subResult.rows[0]?.tenant_id as string | undefined;
  if (!tenantId) {
    logger.warn(
      { subscriptionId, invoiceId: invoice.id, eventType },
      `[webhook] ${eventType}: no tenant found for subscription in stripe_subscriptions`
    );
    return null;
  }

  return {
    tenantId,
    subscriptionId,
    periodStart: new Date(invoice.period_start * 1000).toISOString(),
    periodEnd:   new Date(invoice.period_end * 1000).toISOString(),
  };
}

async function _handlePaymentSucceeded(invoice: any, db: any, logger: pino.Logger): Promise<void> {
  const resolved = await _resolveTenantAndPeriod(invoice, db, logger, 'payment_succeeded');
  if (!resolved) return;
  const { tenantId, periodStart, periodEnd, subscriptionId } = resolved;

  const result = await db.query(
    `UPDATE usage_logs
     SET billing_status = 'paid'
     WHERE tenant_id = $1
       AND created_at >= $2
       AND created_at <  $3
       AND billing_status = 'reported'`,
    [tenantId, periodStart, periodEnd]
  );

  logger.info(
    { subscriptionId, tenantId, updatedRows: result.rowCount, invoiceId: invoice.id, periodStart, periodEnd },
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

  // PR-4: billing_status='failed' はDBのCHECK制約に既に定義されていたが、
  // どこからも書き込まれていなかった(常に'reported'のまま滞留し、未回収の検知にも
  // 使えなかった)。payment_succeededと同じ tenant_id + 請求対象期間の突合で記録する。
  const resolved = await _resolveTenantAndPeriod(invoice, db, logger, 'payment_failed');
  if (resolved) {
    const { tenantId, periodStart, periodEnd } = resolved;
    const result = await db.query(
      `UPDATE usage_logs
       SET billing_status = 'failed'
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at <  $3
         AND billing_status = 'reported'`,
      [tenantId, periodStart, periodEnd]
    );
    logger.warn(
      { subscriptionId, tenantId, updatedRows: result.rowCount, invoiceId: invoice.id },
      '[webhook] payment_failed: billing_status → failed'
    );
  }

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

/**
 * client_admin セルフサービスの Checkout(mode: 'subscription')完了を記録する。
 *
 * ★なぜ webhook 側で記録するか、Checkoutセッション作成側で書き込まないか★
 * Checkout の customer/subscription 確定はカード情報入力を挟む Stripe 側の非同期
 * フローで、セッション作成のレスポンス時点ではまだ確定していない(3DS等で数分
 * 空くこともある)。テナントが success_url に戻ってきたタイミングで書き込むと、
 * 戻ってくる前に離脱したテナントの行が永久に欠ける。webhook はこの完了を
 * Stripe 側から確実に通知してもらえる唯一の経路。
 *
 * metadata.tenant_id は checkout-session 作成時(billingApi.ts の
 * POST /v1/admin/my-tenant/billing/checkout-session)に必ず載せる契約。無ければ、
 * どのテナントの支払いか特定できないため何もしない(黙ってどこかのテナントに
 * 紐付けると越境事故になる)。
 */
async function _handleCheckoutSessionCompleted(
  session: any,
  db: any,
  logger: pino.Logger
): Promise<void> {
  if (session.mode !== 'subscription') return; // 一時金決済等、他モードは対象外

  const tenantId = session.metadata?.tenant_id as string | undefined;
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

  if (!tenantId || !subscriptionId || !customerId) {
    logger.error(
      { sessionId: session.id, tenantId, subscriptionId, customerId },
      '[webhook] checkout.session.completed: tenant_id/subscription/customer のいずれかが欠けている — 記録できない'
    );
    return;
  }

  // stripe_price_id(「そのテナントのプランを代表する price」の表示専用列。
  // 業務ロジックからは読まれない — schemaHealth.ts の存在チェック以外に参照箇所なし)
  // は null で先に行を作る。Checkout の line_items をここで読み直して二重に真実を
  // 持たない。次にプランが変わったとき、subscriptionSync.ts の同期処理が
  // 代表 price を書き込んで埋める(それまでは null のままで、機能的な影響は無い)。
  await db.query(
    `INSERT INTO stripe_subscriptions
       (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, is_active)
     VALUES ($1, $2, $3, NULL, true)
     ON CONFLICT (tenant_id) DO UPDATE SET
       stripe_customer_id     = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       is_active               = true,
       updated_at              = NOW()`,
    [tenantId, customerId, subscriptionId]
  );

  logger.info(
    { tenantId, subscriptionId, customerId },
    '[webhook] checkout.session.completed: テナントのセルフサービス決済登録を記録した'
  );
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
