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

// プラン倍率の定義は planPricing.ts に移した（usageTracker.ts が利用記録時に
// 焼き付けるため、Stripe連携モジュールへの依存を持たせたくない）。
// 既存の import 元を壊さないよう、ここから re-export する。
export { PLAN_MULTIPLIERS, planMultiplier } from './planPricing';
import { planMultiplier } from './planPricing';

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

export function getPeriodYyyyMm(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

export function periodToDateRange(periodYyyyMm: string): { startDate: string; endDate: string } {
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

  // 倍率は行ごとに「利用時点で焼き付けた」 usage_logs.plan_multiplier を使う
  // （migration_usage_logs_plan_snapshot.sql）。tenants.plan を読んで月全体に
  // 掛けると、月中のプラン変更が月初まで遡って請求を書き換えてしまう
  // （enterprise で1か月使って月末に free_ad へ落とすと全額0円になる）。
  //
  // $4 = tenants.plan 由来の倍率。plan_multiplier が NULL の行
  // （本カラム追加前の既存行 / 記録時にプランを確定できなかった行）だけに
  // 適用する後方互換のフォールバックであり、確定済みの行には効かない。
  //
  // GID 1216944003337186: billable=false（管理系LLM機能・chargeOneOffJpyで別途請求済みの
  // sai_agent等）は原価がusage_logsに記録されていてもStripe請求数量の集計対象から除外する。
  // ★C-2: 月の累積を毎回丸ごと再計算し、絶対値として送る(増分方式をやめる)★
  //
  // 旧設計は「pending 行だけを対象に集計→成功したら reported に倒す」という
  // 増分方式のように書かれていたが、Stripe へは action:'set'(絶対値の置き換え)
  // で送っていた。この不一致は「同月2回目以降は idempotencyKey 一致で丸ごと
  // スキップする」ガードに隠れて表面化していなかった(Asana 1217808138968200)。
  // もしそのガードだけを外すと、2回目の実行が「新たにpendingになった差分」を
  // 絶対値としてStripeへ送り、月初からの分を上書きして消してしまう
  // (過少請求。例: 1日目 100件送信→2日目 pending の新規50件だけを『合計』として送ると
  // 累積100件が消えて50件になる)。
  //
  // 正しい直し方は「請求状態を進行管理しない」こと: billing_status を集計の
  // フィルタから外し、その月に発生した billable 行を毎回すべて数え、
  // 常に「月初からの累積」を絶対値として送る。これにより:
  //   - 集計と reported 更新の間のレース(Asana課題)も消える(集計対象が
  //     状態遷移に依存しないため、順序を問わない)
  //   - リトライが安全になる(同じ絶対値を再送するだけ)
  //   - 遅れて届いた行も次回実行で自動的に拾われる
  //   - 冪等キーの連番化が不要になる(下記、金額そのものをキーに含める)
  const fallbackMultiplier = planMultiplier(plan);
  const aggResult = await db.query(
    `SELECT
       COUNT(*)::integer           AS total_requests,
       COALESCE(SUM(cost_total_cents), 0)::integer AS total_cost_cents,
       COALESCE(SUM(
         CASE WHEN feature_used = 'anam_session'
              THEN CEIL(COALESCE(anam_session_seconds, 0) / 60.0)
              ELSE 1
         END
       ), 0)::integer AS billable_units,
       COALESCE(SUM(
         (CASE WHEN feature_used = 'anam_session'
               THEN CEIL(COALESCE(anam_session_seconds, 0) / 60.0)
               ELSE 1
          END) * COALESCE(plan_multiplier, $4::numeric)
       ), 0)::numeric AS billed_units_weighted,
       COUNT(*) FILTER (WHERE plan_multiplier IS NULL)::integer AS unstamped_rows
     FROM usage_logs
     WHERE tenant_id = $1
       AND created_at >= $2
       AND created_at <  $3
       AND billable = true`,
    [tenantId, startDate, endDate, fallbackMultiplier]
  );

  const totalRequests: number = aggResult.rows[0].total_requests;
  const totalCostCents: number = aggResult.rows[0].total_cost_cents;
  // anam_session行は秒→分換算（anamSessionBillableUnits と同じ切り上げ規則をSQL側でも適用）、
  // それ以外は従来通り1行=1単位。テキストのみのテナントは billableUnits === totalRequests。
  const billableUnits: number = aggResult.rows[0].billable_units;
  const unstampedRows: number = aggResult.rows[0].unstamped_rows;

  if (totalRequests === 0) {
    logger.debug({ tenantId, periodYyyyMm }, '[stripeSync] no pending usage');
    return;
  }

  // 行ごとの倍率で重み付けした合計を最後に1回だけ切り上げる
  // （行ごとに切り上げると小数倍率のテナントで請求が膨らむ）。
  // pg は numeric を文字列で返すため Number() を通す。
  const billedQuantity = Math.ceil(Number(aggResult.rows[0].billed_units_weighted));

  if (unstampedRows > 0) {
    // migration 適用直後は既存行が NULL のまま残るため、当面は正常に出る。
    // 適用から1か月以上経っても出続ける場合は usageTracker の焼き付けが
    // 効いていない（= 遡及請求の穴が残っている）ことを意味する。
    logger.warn(
      { tenantId, periodYyyyMm, unstampedRows, totalRequests, fallbackMultiplier },
      '[stripeSync] rows without plan_multiplier fell back to current tenants.plan'
    );
  }

  // 冪等キーに billedQuantity を含める。
  // 「(テナント, 月)」だけをキーにすると、金額が変わった2回目以降の実行が
  // 同じキーでスキップされてしまう(C-2 導入前の不具合)。金額をキーに含めることで:
  //   - 前回と同額なら同じキー → 既存行がヒットしてスキップ(何も変わっていない)
  //   - 増えていれば新しいキー → 新しい絶対値として素通りする
  // billedQuantity はその月の累積(集計クエリが行を消費しない限り単調非減少)なので、
  // 同一(テナント,月)内で過去のキーへ後戻りすることはない。
  const idempotencyKey = `billing:${tenantId}:${periodYyyyMm}:${billedQuantity}`;

  // 同額を既に送信済みならスキップ(直前の実行から変化が無い)
  const existing = await db.query(
    `SELECT status FROM stripe_usage_reports WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (existing.rows.length > 0 && existing.rows[0].status === 'sent') {
    logger.debug({ tenantId, periodYyyyMm, billedQuantity }, '[stripeSync] same amount already reported, skipping');
    return;
  }

  const subInfo = await getSubscriptionItemId(db, tenantId, stripe, logger);
  if (!subInfo) return;

  // stripe_usage_reports にupsert（冪等）。billed_quantity は「送信を試みる数量」
  // をこの時点で先に記録する。Stripe API呼び出し(下記)が例外→リトライを繰り返す間も、
  // 「何を送ろうとしたか」を突合から追えるようにするため、送信成否を待たずに書く。
  //
  // ★migration未適用でも他テナントの報告を止めないこと★
  // ここが例外を投げると、呼び出し元の reportUsageToStripe の for ループに伝播し、
  // その回のバッチで後続の全テナントが報告されないまま24時間止まる
  // (index.ts のスケジューラは reportUsageToStripe 全体を1つの catch で包むだけで、
  // テナント単位のエラー分離をしていない)。migration_stripe_usage_reports_billed_quantity.sql
  // が未適用のままデプロイすると、最初のテナントで即座に全滅しかねないため、
  // usageTracker.ts と同じパターンで 42703 のときだけ旧カラム構成に1回だけ
  // フォールバックし、記録の消失(=バッチ全体の停止)を防ぐ。
  try {
    await db.query(
      `INSERT INTO stripe_usage_reports
         (tenant_id, period_yyyymm, idempotency_key, total_requests, total_cost_cents, billed_quantity)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         total_requests   = EXCLUDED.total_requests,
         total_cost_cents = EXCLUDED.total_cost_cents,
         billed_quantity  = EXCLUDED.billed_quantity,
         updated_at       = NOW()`,
      [tenantId, periodYyyyMm, idempotencyKey, totalRequests, totalCostCents, billedQuantity]
    );
  } catch (err) {
    if ((err as { code?: string })?.code !== '42703') throw err;
    logger.error(
      { err, tenantId, periodYyyyMm },
      '[stripeSync] stripe_usage_reports に billed_quantity 列が無い — ' +
      'migration_stripe_usage_reports_billed_quantity.sql が未適用。旧カラムで継続するが、' +
      '突合用の billed_quantity は記録できない状態のまま。至急 migration を適用すること'
    );
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
  }

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

      // billing_status は集計の対象条件ではなくなった(上記)ので、ここでの更新は
      // 「この月は少なくとも1回、直近の送信に含まれた」という観測用の印にすぎない。
      // billable=false の行はこの集計・報告に含まれていないため 'reported' にはしない
      // （'pending' のまま維持。原価可視化のための行であり、Stripeに送信済みという意味を
      // 持たせない）。'pending' 縛りを外すのは、集計時点より後に届いた行も
      // 次回実行で自然に拾われるため、状態遷移の順序に依存させないため。
      await db.query(
        `UPDATE usage_logs
         SET billing_status = 'reported'
         WHERE tenant_id = $1
           AND created_at >= $2
           AND created_at <  $3
           AND billable = true`,
        [tenantId, startDate, endDate]
      );

      logger.info(
        // plan / fallbackMultiplier は「未焼き付け行に適用した値」であって、
        // 焼き付け済み行の倍率ではない（月中に変更があれば行ごとに異なる）。
        { tenantId, periodYyyyMm, totalRequests, billableUnits, billedQuantity,
          currentPlan: plan, fallbackMultiplier, unstampedRows, totalCostCents },
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
