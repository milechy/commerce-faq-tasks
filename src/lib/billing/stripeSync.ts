// src/lib/billing/stripeSync.ts
// Phase32: Stripe Usage Record API連携（日次バッチ）

import type pino from 'pino';

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 1000;

function getStripeClient(): any {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not set');
  // @ts-ignore — stripe パッケージは backend_deps.md で申請済み
  const Stripe = require('stripe');
  return new Stripe(secret, { apiVersion: '2024-06-20' });
}

function getPeriodYyyyMm(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

function periodToDateRange(periodYyyyMm: string): { startDate: string; endDate: string } {
  const year  = Number(periodYyyyMm.slice(0, 4));
  const month = Number(periodYyyyMm.slice(4, 6));
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // 翌月1日 = 終了境界（排他）
  const nextMonth = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1);
  const endDate = nextMonth.toISOString().slice(0, 10);
  return { startDate, endDate };
}

/**
 * テナントのStripe SubscriptionItem IDを取得する。
 */
async function getSubscriptionItemId(
  db: any,
  tenantId: string,
  stripe: any,
  logger: pino.Logger
): Promise<{ subscriptionId: string; itemId: string } | null> {
  const result = await db.query(
    `SELECT stripe_subscription_id
     FROM stripe_subscriptions
     WHERE tenant_id = $1 AND is_active = true
     LIMIT 1`,
    [tenantId]
  );
  if (result.rows.length === 0) {
    logger.warn({ tenantId }, '[stripeSync] no active subscription found');
    return null;
  }

  const subscriptionId = result.rows[0].stripe_subscription_id as string;
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const item = (subscription.items?.data ?? [])[0];
    if (!item) {
      logger.warn({ tenantId, subscriptionId }, '[stripeSync] subscription has no items');
      return null;
    }
    return { subscriptionId, itemId: item.id };
  } catch (err) {
    logger.error({ err, tenantId, subscriptionId }, '[stripeSync] failed to retrieve subscription');
    return null;
  }
}

/**
 * 指定期間のテナント使用量を集計してStripeに報告する（冪等）。
 *
 * @param db  pg.Pool インスタンス
 * @param logger  pino Logger
 * @param opts.tenantId  省略時は全アクティブテナント
 * @param opts.periodYyyyMm  省略時は現在月（例: "202603"）
 */
export async function reportUsageToStripe(
  db: any,
  logger: pino.Logger,
  opts: { tenantId?: string; periodYyyyMm?: string } = {}
): Promise<void> {
  const stripe = getStripeClient();
  const periodYyyyMm = opts.periodYyyyMm ?? getPeriodYyyyMm();

  const tenantsQuery = opts.tenantId
    ? await db.query(
        `SELECT tenant_id FROM stripe_subscriptions WHERE tenant_id = $1 AND is_active = true`,
        [opts.tenantId]
      )
    : await db.query(
        `SELECT DISTINCT tenant_id FROM stripe_subscriptions WHERE is_active = true`
      );

  for (const row of tenantsQuery.rows) {
    await _reportTenantUsage(db, stripe, logger, row.tenant_id as string, periodYyyyMm);
  }
}

async function _reportTenantUsage(
  db: any,
  stripe: any,
  logger: pino.Logger,
  tenantId: string,
  periodYyyyMm: string
): Promise<void> {
  // Phase39: billing_enabled / billing_free_from / billing_free_until チェック
  const tenantRow = await db.query(
    `SELECT billing_enabled, billing_free_from, billing_free_until FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (tenantRow.rows.length > 0) {
    const tenant = tenantRow.rows[0];
    if (!tenant.billing_enabled) {
      logger.info({ tenantId }, `[billing] ${tenantId}: billing not enabled, skipping Stripe report`);
      return;
    }
    const now = new Date();
    const freeFrom  = tenant.billing_free_from  ? new Date(tenant.billing_free_from)  : null;
    const freeUntil = tenant.billing_free_until ? new Date(tenant.billing_free_until) : null;
    if (freeFrom && freeUntil && now >= freeFrom && now <= freeUntil) {
      logger.info(
        { tenantId, freeFrom: tenant.billing_free_from, freeUntil: tenant.billing_free_until },
        `[billing] ${tenantId}: free period ${tenant.billing_free_from} ~ ${tenant.billing_free_until}, skipping`
      );
      return;
    }
  }

  const { startDate, endDate } = periodToDateRange(periodYyyyMm);

  const aggResult = await db.query(
    `SELECT
       COUNT(*)::integer           AS total_requests,
       COALESCE(SUM(cost_total_cents), 0)::integer AS total_cost_cents
     FROM usage_logs
     WHERE tenant_id = $1
       AND created_at >= $2
       AND created_at <  $3
       AND billing_status = 'pending'`,
    [tenantId, startDate, endDate]
  );

  const totalRequests: number = aggResult.rows[0].total_requests;
  const totalCostCents: number = aggResult.rows[0].total_cost_cents;

  if (totalRequests === 0) {
    logger.debug({ tenantId, periodYyyyMm }, '[stripeSync] no pending usage');
    return;
  }

  const idempotencyKey = `billing:${tenantId}:${periodYyyyMm}`;

  // 既に送信済みならスキップ
  const existing = await db.query(
    `SELECT status FROM stripe_usage_reports WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (existing.rows.length > 0 && existing.rows[0].status === 'sent') {
    logger.debug({ tenantId, periodYyyyMm }, '[stripeSync] already reported, skipping');
    return;
  }

  const subInfo = await getSubscriptionItemId(db, tenantId, stripe, logger);
  if (!subInfo) return;

  // stripe_usage_reports にupsert（冪等）
  await db.query(
    `INSERT INTO stripe_usage_reports
       (tenant_id, period_yyyymm, idempotency_key, total_requests, total_cost_cents)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       total_requests   = EXCLUDED.total_requests,
       total_cost_cents = EXCLUDED.total_cost_cents,
       updated_at       = NOW()`,
    [tenantId, periodYyyyMm, idempotencyKey, totalRequests, totalCostCents]
  );

  // Stripe送信（最大3回リトライ）
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const usageRecord = await stripe.subscriptionItems.createUsageRecord(
        subInfo.itemId,
        {
          quantity:  totalRequests,
          timestamp: Math.floor(Date.now() / 1000),
          action:    'set',
        },
        { idempotencyKey }
      );

      await db.query(
        `UPDATE stripe_usage_reports
         SET status = 'sent', stripe_usage_record_id = $1, updated_at = NOW()
         WHERE idempotency_key = $2`,
        [usageRecord.id, idempotencyKey]
      );

      await db.query(
        `UPDATE usage_logs
         SET billing_status = 'reported'
         WHERE tenant_id = $1
           AND created_at >= $2
           AND created_at <  $3
           AND billing_status = 'pending'`,
        [tenantId, startDate, endDate]
      );

      logger.info(
        { tenantId, periodYyyyMm, totalRequests, totalCostCents },
        '[stripeSync] usage reported to Stripe'
      );
      return;
    } catch (err) {
      lastError = err as Error;
      logger.warn(
        { err, tenantId, attempt: attempt + 1, maxRetries: MAX_RETRIES },
        '[stripeSync] stripe API error, retrying'
      );
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1)));
      }
    }
  }

  // 全リトライ失敗
  await db.query(
    `UPDATE stripe_usage_reports
     SET status = 'failed',
         retry_count = retry_count + 1,
         last_error  = $1,
         updated_at  = NOW()
     WHERE idempotency_key = $2`,
    [lastError?.message?.slice(0, 500) ?? 'unknown', idempotencyKey]
  );

  logger.error(
    { tenantId, periodYyyyMm, error: lastError?.message },
    '[stripeSync] failed after max retries'
  );
}
