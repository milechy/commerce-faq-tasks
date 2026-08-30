// src/lib/billing/stripeWebhook.ts
// Phase32: Stripe Webhook処理

import type pino from 'pino';
import type { Request, Response } from 'express';
import { planFromSubscriptionPriceIds } from './planPricing';
import { invalidateTenantPlanCache } from './planFeatures';

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
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await _handleSubscriptionUpserted(event.data.object, db, logger, event.type);
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

/** stripe_subscription 由来のイベントから price ID の一覧を取り出す。 */
function _priceIdsOfSubscription(subscription: any): string[] {
  const items: any[] = subscription?.items?.data ?? [];
  const ids: string[] = [];
  for (const item of items) {
    const price = item?.price;
    const id = typeof price === 'string' ? price : price?.id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

// subscription が「まだ生きている(item構成を持つ)」とみなせる status。
// canceled / incomplete_expired は終了状態なので stripe_subscriptions.is_active=false へ。
// unpaid / paused / past_due は subscription 自体は存在し続ける(is_active=true のまま)。
// 停止判定は suspensionGate 側が subscription_status を見て行うので、ここは
// 「行が実在するか」を is_active に反映するだけ。
const _TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'canceled',
  'incomplete_expired',
]);

/**
 * customer.subscription.created / updated を処理する。
 *
 * ★従来これらが未処理だった穴★
 * Stripe 側でプランや支払い状態(active/past_due/unpaid 等)が変わっても、
 * webhook が created/updated を握っていなかったため tenants に一切反映されず、
 * 提供停止も plan 追随も起きなかった。ここで
 *   1. tenants.subscription_status(生 status)と delinquent_since(past_due 起点)を焼き付ける
 *   2. price → plan を逆引きして tenants.plan を Stripe の実態に追随させる
 *   3. stripe_subscriptions.is_active / stripe_price_id を更新する
 * を行う。停止「判定」自体は suspensionGate.ts が subscription_status を読んで行う
 * (この関数は状態を記録するだけで、chat/avatar を直接止めはしない)。
 *
 * ★tenant の解決★
 * subscription.metadata.tenant_id(subscriptionSync が付ける)を優先し、無ければ
 * stripe_subscriptions.stripe_subscription_id から逆引きする。どちらでも引けない
 * (created が checkout.session.completed より先に届き、まだ行が無い等)場合は
 * 記録せず warn して抜ける。後続の updated、または checkout 完了時の記録で追いつく。
 */
async function _handleSubscriptionUpserted(
  subscription: any,
  db: any,
  logger: pino.Logger,
  eventType: string
): Promise<void> {
  const subscriptionId = subscription?.id as string | undefined;
  const status = typeof subscription?.status === 'string' ? subscription.status : null;
  if (!subscriptionId) {
    logger.warn({ eventType }, '[webhook] subscription.upserted: no subscription id');
    return;
  }

  // tenant を解決する。
  let tenantId: string | undefined = subscription?.metadata?.tenant_id;
  if (!tenantId) {
    const r = await db.query(
      `SELECT tenant_id FROM stripe_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
      [subscriptionId]
    );
    tenantId = r.rows[0]?.tenant_id as string | undefined;
  }
  if (!tenantId) {
    // まだ行が無い(checkout 完了前の created 等)。記録できないが、これは正常系。
    logger.info(
      { subscriptionId, eventType, status },
      '[webhook] subscription.upserted: tenant未解決のためスキップ(後続イベント/checkout完了で追いつく)'
    );
    return;
  }

  const priceIds = _priceIdsOfSubscription(subscription);
  const mappedPlan = planFromSubscriptionPriceIds(priceIds); // 'starter'|'standard'|'growth'|null
  const representativePriceId = priceIds[0] ?? null;
  const subIsActive = status === null ? true : !_TERMINAL_SUBSCRIPTION_STATUSES.has(status);

  // (1) stripe_subscriptions の is_active / stripe_price_id を追随(既存列のみ・常に安全)。
  //     行が無い(metadata経由でtenantだけ解決できた)場合は 0 行更新で無害。
  const subUpdate = await db.query(
    `UPDATE stripe_subscriptions
     SET is_active = $2,
         stripe_price_id = COALESCE($3, stripe_price_id),
         updated_at = NOW()
     WHERE stripe_subscription_id = $1`,
    [subscriptionId, subIsActive, representativePriceId]
  );

  // (2) price → plan を tenants.plan に反映(既存列のみ)。mappedPlan が null
  //     (enterprise の個別price・未知price)なら書き換えない。実際に変わった行が
  //     あるときだけ plan キャッシュを飛ばす。
  if (mappedPlan) {
    const planUpdate = await db.query(
      `UPDATE tenants SET plan = $2, updated_at = NOW()
       WHERE id = $1 AND plan <> $2 AND plan NOT IN ('enterprise')
       RETURNING id`,
      [tenantId, mappedPlan]
    );
    if ((planUpdate.rowCount ?? 0) > 0) {
      invalidateTenantPlanCache(tenantId);
      logger.info(
        { tenantId, subscriptionId, plan: mappedPlan },
        '[webhook] subscription.upserted: price→plan を tenants.plan に反映した'
      );
    }
  }

  // (3) subscription_status / delinquent_since を焼き付ける(新規列)。
  //     migration 未適用(42703)は fail-open: 停止ゲートの材料が無いだけで、
  //     (1)(2) の反映と webhook 自体の成功は保つ。
  try {
    await db.query(
      `UPDATE tenants SET
         subscription_status = $2,
         delinquent_since = CASE
           WHEN $2 = 'past_due' THEN COALESCE(delinquent_since, NOW())
           WHEN $2 IN ('active', 'trialing') THEN NULL
           ELSE delinquent_since
         END,
         updated_at = NOW()
       WHERE id = $1`,
      [tenantId, status]
    );
  } catch (err: any) {
    if (err?.code === '42703') {
      logger.warn(
        { tenantId, subscriptionId },
        '[webhook] subscription.upserted: subscription_status 列が無い(migration未適用)ため停止ゲート材料の記録をスキップ'
      );
    } else {
      throw err; // それ以外のDB例外は 500 で再送に委ねる。
    }
  }

  logger.info(
    { tenantId, subscriptionId, eventType, status, mappedPlan, subUpdated: subUpdate.rowCount },
    '[webhook] subscription.upserted: 状態を反映した'
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

  // 提供停止ゲート(suspensionGate.ts)が subscription_status からも suspended を
  // 判定できるよう、tenants にも 'canceled' を焼き付ける。subActive=false 単独でも
  // suspended になるが、status を残しておくと運用画面/監査で理由が読める。
  // subscription からは stripe_subscription_id → tenant_id を逆引きする。
  const subRow = await db.query(
    `SELECT tenant_id FROM stripe_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
    [subscriptionId]
  );
  const tenantId = subRow.rows[0]?.tenant_id as string | undefined;
  if (tenantId) {
    try {
      await db.query(
        `UPDATE tenants SET subscription_status = 'canceled', updated_at = NOW() WHERE id = $1`,
        [tenantId]
      );
    } catch (err: any) {
      if (err?.code !== '42703') throw err; // 未適用はスキップ、それ以外は再送へ
    }
  }

  logger.warn(
    { subscriptionId, tenantId, updatedRows: result.rowCount },
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

  // ★stripe_price_id は migration.sql で TEXT NOT NULL★ 以前はここに NULL を
  // 挿入していたが、NOT NULL制約違反で本INSERTが新規・ON CONFLICT更新の両経路とも
  // 必ず失敗し、セルフサービス決済が一度も記録されない事故になっていた
  // (2026-08-26 レビュー是正、実Postgresで再現確認済み)。
  //
  // 代表priceはCheckoutのline_itemsを推測で再構成せず、今まさにStripe上に存在する
  // subscriptionの実itemから読む(単一の真実)。取得できなければ記録せず、Stripeの
  // 5xxリトライに任せる(handler_errorでこの関数全体を再試行させる)。
  const stripe = getStripeClient();
  let representativePriceId: string | null = null;
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const firstItem = subscription.items?.data?.[0];
    const price = firstItem?.price;
    representativePriceId = typeof price === 'string' ? price : (price?.id ?? null);
  } catch (err) {
    logger.error(
      { err, subscriptionId },
      '[webhook] checkout.session.completed: subscription取得に失敗、代表priceを解決できない'
    );
  }

  if (!representativePriceId) {
    logger.error(
      { sessionId: session.id, tenantId, subscriptionId },
      '[webhook] checkout.session.completed: 代表priceを解決できず記録できない(subscriptionにitemが無い、またはStripe取得失敗)'
    );
    throw new Error('checkout.session.completed: representative price unresolved');
  }

  // ★衝突検知★ 既にアクティブな別subscriptionが記録済みなら上書きしない。
  // 別タブに残った古いCheckoutが後で完了する等で同一テナントに2本目の
  // subscriptionが作られた場合、無条件上書き(旧実装)だと先に作られた
  // subscriptionの行がDBから消え、Stripe側だけ課金され続ける孤児になる
  // (2026-08-26 レビュー是正)。is_active=false の既存行(解約済み等)は
  // 再契約として上書きを許す。
  const result = await db.query(
    `INSERT INTO stripe_subscriptions
       (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (tenant_id) DO UPDATE SET
       stripe_customer_id     = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id        = EXCLUDED.stripe_price_id,
       is_active               = true,
       updated_at              = NOW()
     WHERE stripe_subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id
        OR NOT stripe_subscriptions.is_active
     RETURNING tenant_id`,
    [tenantId, customerId, subscriptionId, representativePriceId]
  );

  if ((result.rowCount ?? 0) === 0) {
    // 既に別のアクティブなsubscriptionが紐づいている(孤児が生まれた)。
    // このCheckoutで新しく作られた方をキャンセルして二重課金を防ぎ、運用に通知する。
    logger.error(
      { tenantId, subscriptionId, customerId },
      '[webhook] checkout.session.completed: 既に別のsubscriptionが記録済みのため、新規subscriptionをキャンセルする'
    );
    try {
      await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      logger.error({ err, subscriptionId }, '[webhook] checkout.session.completed: 孤児subscriptionのキャンセルに失敗');
    }
    await _sendSlackAlert({ type: 'orphaned_subscription', subscriptionId, tenantId }, logger);
    return;
  }

  logger.info(
    { tenantId, subscriptionId, customerId },
    '[webhook] checkout.session.completed: テナントのセルフサービス決済登録を記録した'
  );
}

interface SlackAlertPayload {
  type: 'payment_failed' | 'subscription_deleted' | 'orphaned_subscription';
  subscriptionId: string;
  invoiceId?: string;
  amountDue?: number;
  tenantId?: string;
}

async function _sendSlackAlert(payload: SlackAlertPayload, logger: pino.Logger): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const text =
    payload.type === 'payment_failed'
      ? `⚠️ *課金エラー*: 支払い失敗 | subscription: ${payload.subscriptionId} | invoice: ${payload.invoiceId} | 金額: ${payload.amountDue}セント`
      : payload.type === 'subscription_deleted'
      ? `🚨 *解約アラート*: サブスクリプション削除 | subscription: ${payload.subscriptionId}`
      : `🚨 *孤児サブスクリプション*: tenant ${payload.tenantId} に既に別のsubscriptionが記録済みのため、新規subscription ${payload.subscriptionId} をキャンセルしました(別タブに残った古いCheckoutの完走等)。手動確認してください。`;

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
