// src/lib/billing/stripeSync.ts
// Phase32: Stripe Usage Record API連携（日次バッチ）

import type pino from 'pino';

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 1000;

/** pino.Logger / AppLogger(lib/logger.ts)どちらでも渡せる最小限のロガー形状 */
interface MinimalLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

// プラン倍率: Stripe に報告する数量に乗じる（リクエスト課金 × プラン別単価）。
// admin-ui PLAN_OPTIONS と一致（Starter ×1.0 / Growth ×1.5 / Enterprise ×2.5）。
export const PLAN_MULTIPLIERS: Record<string, number> = {
  starter: 1.0,
  growth: 1.5,
  enterprise: 2.5,
};
export function planMultiplier(plan: string | null | undefined): number {
  return PLAN_MULTIPLIERS[plan ?? 'starter'] ?? 1.0;
}

/** 環境変数から LemonSlice 月額固定費(JPY)を取得。未設定/0 なら按分課金は無効。 */
export function getLemonsliceMonthlyFeeJpy(): number {
  return Number(process.env.LEMONSLICE_MONTHLY_FEE_JPY ?? '0') || 0;
}

/** 環境変数から LiveKit (Ship プラン) 月額固定費(JPY)を取得。未設定/0 なら按分課金は無効。 */
export function getLivekitMonthlyFeeJpy(): number {
  return Number(process.env.LIVEKIT_MONTHLY_FEE_JPY ?? '0') || 0;
}

/**
 * 環境変数からプラットフォーム共通の月額固定費(JPY)を取得。未設定/0 なら按分課金は無効。
 * Supabase / Cloudflare / Hetzner VPS / Elasticsearch 等、全テナントが共有するインフラ費の
 * 合計額を1本で設定する（費目別の内訳は持たない）。アバター専用費(LemonSlice/LiveKit)とは
 * 分母が異なり、全アクティブテナントで割る（scope='all'）。
 */
export function getPlatformMonthlyFeeJpy(): number {
  return Number(process.env.PLATFORM_MONTHLY_FEE_JPY ?? '0') || 0;
}

/** 月額固定費を当月アバター利用テナント数で均等割りした1テナント分(JPY、切り上げ)。 */
export function monthlyShareJpy(monthlyFeeJpy: number, tenantCount: number): number {
  if (monthlyFeeJpy <= 0 || tenantCount <= 0) return 0;
  return Math.ceil(monthlyFeeJpy / tenantCount);
}

/** @deprecated 後方互換のためのエイリアス。新規は monthlyShareJpy を使う。 */
export const lemonsliceShareJpy = monthlyShareJpy;

/**
 * 月額固定費を当月アクティブなテナント間で均等割りして Stripe 請求に上乗せする共通ロジック。
 * テナント単位・月1回・冪等。
 * - 無効化: 対象 feeJpy が未設定/0 のとき何もしない（デフォルト OFF）
 * - cfg.scope で分母（割り勘の対象集合）を切り替える:
 *   - 'avatar': アバター専用費（LemonSlice / LiveKit）。当月 feature_used='avatar' かつ
 *     billing_enabled=true のテナントで割る（仕様B）。アバターを使ったテナントだけが負担。
 *   - 'all': プラットフォーム共通費（Supabase/Cloudflare/Hetzner/ES）。当月に何らかの利用が
 *     あり billing_enabled=true のテナントで割る。アバター有無を問わず全アクティブテナントが負担。
 *
 * cfg.table は in-code 定数のみ（ユーザー入力を渡さない）— SQL に直挿しするため。
 */
async function _chargeMonthlyFixedShare(
  db: any,
  stripe: any,
  logger: pino.Logger,
  tenantId: string,
  periodYyyyMm: string,
  startDate: string,
  endDate: string,
  customerId: string | null,
  cfg: { feeJpy: number; table: string; label: string; idempotencyPrefix: string; scope: 'avatar' | 'all' }
): Promise<void> {
  const { feeJpy, table, label, idempotencyPrefix, scope } = cfg;
  if (feeJpy <= 0) return; // デフォルト OFF
  if (!customerId) {
    logger.warn({ tenantId, fee: label }, '[stripeSync] monthly fixed: no customerId, skipping');
    return;
  }

  // scope='avatar' はアバター利用のみを対象にする。'all' は機能を問わない（in-code 定数）。
  const featureFilter = scope === 'avatar' ? "AND feature_used = 'avatar'" : '';

  // このテナントが当月に対象の利用をしたか
  const used = await db.query(
    `SELECT 1 FROM usage_logs
      WHERE tenant_id = $1 ${featureFilter}
        AND created_at >= $2 AND created_at < $3 LIMIT 1`,
    [tenantId, startDate, endDate]
  );
  if (used.rows.length === 0) return;

  // 当月の課金対象テナント数（按分の分母）
  const cntRes = await db.query(
    `SELECT COUNT(DISTINCT u.tenant_id)::integer AS cnt
       FROM usage_logs u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.created_at >= $1 AND u.created_at < $2
        AND t.billing_enabled = true
        ${scope === 'avatar' ? "AND u.feature_used = 'avatar'" : ''}`,
    [startDate, endDate]
  );
  const tenantCount: number = Math.max(1, cntRes.rows[0]?.cnt ?? 1);
  const share = monthlyShareJpy(feeJpy, tenantCount);
  if (share <= 0) return;

  // 冪等: テナント×月で1回だけ。INSERT 成功時のみ Stripe 請求を作成する。
  const ins = await db.query(
    `INSERT INTO ${table} (tenant_id, period_yyyymm, amount_jpy, tenant_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, period_yyyymm) DO NOTHING
     RETURNING tenant_id`,
    [tenantId, periodYyyyMm, share, tenantCount]
  );
  if (ins.rows.length === 0) return; // 既に請求済み

  try {
    await stripe.invoiceItems.create(
      {
        customer:    customerId,
        amount:      share, // JPY は最小単位=1円
        currency:    'jpy',
        description: `${label} 月額按分 ${periodYyyyMm} (1/${tenantCount})`,
      },
      { idempotencyKey: `${idempotencyPrefix}:${tenantId}:${periodYyyyMm}` }
    );
    logger.info(
      { tenantId, periodYyyyMm, share, tenantCount, feeJpy, fee: label },
      '[stripeSync] monthly fixed share charged'
    );
  } catch (err) {
    // Stripe 失敗時は冪等レコードを取り消して次回再試行できるようにする
    await db.query(
      `DELETE FROM ${table} WHERE tenant_id = $1 AND period_yyyymm = $2`,
      [tenantId, periodYyyyMm]
    );
    logger.error({ err, tenantId, periodYyyyMm, fee: label }, '[stripeSync] monthly fixed charge failed, rolled back');
  }
}

function getStripeClient(): any {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not set');
  const Stripe = require('stripe');
  return new Stripe(secret, { apiVersion: '2024-06-20' });
}

/**
 * テナントに単発のJPY金額をStripe Invoice Itemとして直接請求する。
 * option_orders(代行作業)等、リクエスト数ベースの従量課金(reportUsageToStripe)には
 * そぐわない一時金の請求に使う。冪等(idempotencyKeyで重複防止)、billing_enabled/
 * 無料期間もreportUsageToStripeと同じ規則でチェックする。
 * @returns 請求できたら true。billing無効・customerId不明・Stripeエラー時は false。
 */
export async function chargeOneOffJpy(
  db: any,
  logger: MinimalLogger,
  opts: { tenantId: string; amountJpy: number; description: string; idempotencyKey: string },
): Promise<boolean> {
  const { tenantId, amountJpy, description, idempotencyKey } = opts;
  if (amountJpy <= 0) return false;

  try {
    const tenantRow = await db.query(
      `SELECT billing_enabled, billing_free_from, billing_free_until FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const tenant = tenantRow.rows[0];
    if (!tenant?.billing_enabled) {
      logger.info({ tenantId }, '[stripeSync] chargeOneOffJpy: billing not enabled, skipping');
      return false;
    }
    const now = new Date();
    const freeFrom  = tenant.billing_free_from  ? new Date(tenant.billing_free_from)  : null;
    const freeUntil = tenant.billing_free_until ? new Date(tenant.billing_free_until) : null;
    if (freeFrom && freeUntil && now >= freeFrom && now <= freeUntil) {
      logger.info({ tenantId }, '[stripeSync] chargeOneOffJpy: free period, skipping');
      return false;
    }

    const stripe = getStripeClient();
    const subInfo = await getSubscriptionItemId(db, tenantId, stripe, logger);
    if (!subInfo?.customerId) {
      logger.warn({ tenantId }, '[stripeSync] chargeOneOffJpy: no customerId, skipping');
      return false;
    }

    await stripe.invoiceItems.create(
      { customer: subInfo.customerId, amount: Math.round(amountJpy), currency: 'jpy', description },
      { idempotencyKey }
    );
    logger.info({ tenantId, amountJpy, description }, '[stripeSync] one-off charge created');
    return true;
  } catch (err) {
    logger.error({ err, tenantId, amountJpy, description }, '[stripeSync] one-off charge failed');
    return false;
  }
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
  logger: MinimalLogger
): Promise<{ subscriptionId: string; itemId: string; customerId: string | null } | null> {
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
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : (subscription.customer?.id ?? null);
    return { subscriptionId, itemId: item.id, customerId };
  } catch (err) {
    logger.error({ err, tenantId, subscriptionId }, '[stripeSync] failed to retrieve subscription');
    return null;
  }
}

/**
 * anam_session 1行分の請求数量（分単位、切り上げ）を返す。
 *
 * Anam.ai は $0.16/分の時間課金だが、Stripe報告数量は他機能と同じ「1行=1リクエスト」の
 * まま合算すると、3分セッション(原価 約$0.16×3)が「1リクエスト」分の単価でしか請求されず
 * 赤字になる（GID 1216944002701788）。anam_session行のみ秒→分に換算して数量に加算する。
 *
 * 切り上げ規則: 0秒は0（対象外）。1秒でも経過すれば1分として計上する
 * （例: 59秒→1分、60秒→1分、61秒→2分、180秒→3分）。負値は0を返す。
 */
export function anamSessionBillableUnits(sessionSeconds: number | null | undefined): number {
  const seconds = sessionSeconds ?? 0;
  if (seconds <= 0) return 0;
  return Math.ceil(seconds / 60);
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
  // プラン倍率算出のため plan も取得する。
  const tenantRow = await db.query(
    `SELECT billing_enabled, billing_free_from, billing_free_until, plan FROM tenants WHERE id = $1`,
    [tenantId]
  );
  let plan: string | null = null;
  if (tenantRow.rows.length > 0) {
    const tenant = tenantRow.rows[0];
    plan = tenant.plan ?? null;
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

  // GID 1216944003337186: billable=false（管理系LLM機能・chargeOneOffJpyで別途請求済みの
  // sai_agent等）は原価がusage_logsに記録されていてもStripe請求数量の集計対象から除外する。
  const aggResult = await db.query(
    `SELECT
       COUNT(*)::integer           AS total_requests,
       COALESCE(SUM(cost_total_cents), 0)::integer AS total_cost_cents,
       COALESCE(SUM(
         CASE WHEN feature_used = 'anam_session'
              THEN CEIL(COALESCE(anam_session_seconds, 0) / 60.0)
              ELSE 1
         END
       ), 0)::integer AS billable_units
     FROM usage_logs
     WHERE tenant_id = $1
       AND created_at >= $2
       AND created_at <  $3
       AND billing_status = 'pending'
       AND billable = true`,
    [tenantId, startDate, endDate]
  );

  const totalRequests: number = aggResult.rows[0].total_requests;
  const totalCostCents: number = aggResult.rows[0].total_cost_cents;
  // anam_session行は秒→分換算（anamSessionBillableUnits と同じ切り上げ規則をSQL側でも適用）、
  // それ以外は従来通り1行=1単位。テキストのみのテナントは billableUnits === totalRequests。
  const billableUnits: number = aggResult.rows[0].billable_units;

  if (totalRequests === 0) {
    logger.debug({ tenantId, periodYyyyMm }, '[stripeSync] no pending usage');
    return;
  }

  // プラン倍率を Stripe 報告数量に適用（リクエスト課金 × プラン別単価）。
  // 実リクエスト数は stripe_usage_reports.total_requests に保持し、請求数量のみ倍率適用する。
  const multiplier = planMultiplier(plan);
  const billedQuantity = Math.ceil(billableUnits * multiplier);

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
          quantity:  billedQuantity,
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

      // billable=false の行はこの集計・報告に含まれていないため 'reported' にはしない
      // （'pending' のまま維持。原価可視化のための行であり、Stripeに送信済みという意味を
      // 持たせない）。
      await db.query(
        `UPDATE usage_logs
         SET billing_status = 'reported'
         WHERE tenant_id = $1
           AND created_at >= $2
           AND created_at <  $3
           AND billing_status = 'pending'
           AND billable = true`,
        [tenantId, startDate, endDate]
      );

      logger.info(
        { tenantId, periodYyyyMm, totalRequests, billableUnits, billedQuantity, plan, multiplier, totalCostCents },
        '[stripeSync] usage reported to Stripe'
      );

      // 月額固定費の按分を上乗せ（いずれもデフォルト OFF・冪等）。
      // アバター専用費(LemonSlice/LiveKit)は scope='avatar'（アバター利用テナントで割る）。
      await _chargeMonthlyFixedShare(
        db, stripe, logger, tenantId, periodYyyyMm, startDate, endDate, subInfo.customerId,
        {
          feeJpy:           getLemonsliceMonthlyFeeJpy(),
          table:            'lemonslice_monthly_charges',
          label:            'LemonSlice',
          idempotencyPrefix:'lemonslice-monthly',
          scope:            'avatar',
        }
      );
      // LiveKit (Ship プラン) 月額固定費の按分（LEMONSLICE と独立・冪等テーブルも別）
      await _chargeMonthlyFixedShare(
        db, stripe, logger, tenantId, periodYyyyMm, startDate, endDate, subInfo.customerId,
        {
          feeJpy:           getLivekitMonthlyFeeJpy(),
          table:            'livekit_monthly_charges',
          label:            'LiveKit',
          idempotencyPrefix:'livekit-monthly',
          scope:            'avatar',
        }
      );
      // プラットフォーム共通費(Supabase/Cloudflare/Hetzner/ES の合計)の按分。
      // scope='all'＝アバター有無を問わず当月アクティブな全テナントで均等割りする。
      await _chargeMonthlyFixedShare(
        db, stripe, logger, tenantId, periodYyyyMm, startDate, endDate, subInfo.customerId,
        {
          feeJpy:           getPlatformMonthlyFeeJpy(),
          table:            'platform_monthly_charges',
          label:            'プラットフォーム基本料',
          idempotencyPrefix:'platform-monthly',
          scope:            'all',
        }
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
