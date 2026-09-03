/**
 * tenantEconomics.ts — テナント別の採算（売上 − API原価）を集計する。
 *
 * ■ このファイルが自分で SQL を書く範囲（重要）
 * 自前のクエリは「マージン前の原価(cost_base_cents)」の集計だけ。
 * 売上・請求数量・込み枠は 100% computeBillingEstimateJpy /
 * computeExpectedBilling 経由で取る。
 * 「同じ数値を2本目のクエリで集計しない。特に請求金額」(src/api/admin/CLAUDE.md)
 * に従うため。請求額の集計SQLをここに書き写すと、片方だけ直した瞬間に
 * 画面によって違う請求額が出る。
 *
 * ■ 認可を持たない
 * 集計だけを行い、ロール検査もレスポンス整形もしない。HTTP レイヤ
 * (billingApi.ts) とチャットエージェント (agent/actionExecutor.ts) の両方から
 * 同じ値を取れるようにするため(fetchBillingCostBreakdown と同じ狙い)。
 *
 * ■ 固定費は含まない
 * ここで出るのは変動費(API原価)のみを引いた粗利。アバター基盤・VPS 等の
 * 固定費按分(platform/lemonslice/livekit_monthly_charges)は含まない。
 * 画面には必ずその旨を出すこと。将来含める場合は
 * allocated_fixed_cost_jpy / operating_profit_jpy を足す(gross_* とは別名にする)。
 */
import { END_USER_FEATURES, MARGIN_MULTIPLIER } from './costCalculator';
import { usdCentsToJpy, fxMeta } from './fx';
import { getMonthRangeJst } from './planQuota';

/** 1リクエストで集計するテナント数の上限。超えたら truncated: true を返す。 */
export const MAX_TENANTS_PER_ECONOMICS_REQUEST = 50;

/** 集計結果のプロセス内キャッシュ TTL。画面のリロード連打で本番DBを殴らないため。 */
const CACHE_TTL_MS = 60_000;

/**
 * 原価の確からしさ。
 * - recorded: 全行が cost_base_cents を持つ（実測。誤差ゼロ）
 * - derived : 全行が未記録で、cost_total_cents から逆算した（推計）
 * - mixed   : 移行期。両方が混ざっている
 */
export type EstimationMethod = 'recorded' | 'derived' | 'mixed';

export interface TenantEconomicsRow {
  tenant_id: string;
  tenant_name: string | null;
  plan: string | null;
  /** usage_logs の行数（会話数ではない）。会話数は text_units。 */
  total_requests: number;
  /** 課金単位の会話数（computeExpectedBilling 由来。billable=true かつ会話単位 DISTINCT）。 */
  text_units: number | null;
  avatar_minutes: number | null;
  /** 売上推計（円）。算出不可は null。★0 にしない★ */
  revenue_estimate_jpy: number | null;
  /** 課金対象行の実原価（USDセント、マージン前）。 */
  cost_base_usd_cents: number;
  cost_base_jpy: number | null;
  /**
   * 非課金機能(admin_tuning / sai_agent 等)の実原価。
   * 売上側(computeExpectedBilling)が billable=true だけを数えるため、
   * 粗利の計算からは外し、実額として別に見せる（基準を揃えるため）。
   */
  cost_nonbillable_usd_cents: number;
  cost_nonbillable_jpy: number | null;
  /** 売上推計 − 課金対象の原価（円）。売上が null なら null。★0 にしない★ */
  gross_profit_jpy: number | null;
  /** 粗利率（%）。売上が null か 0 なら null。 */
  gross_margin_pct: number | null;
  estimation_method: EstimationMethod;
  /** cost_base_cents を実測できている行の割合（0..1）。移行期の判断材料。 */
  recorded_row_ratio: number;
  /** 売上が出せなかった理由。出せた場合は null。 */
  unavailable_reason: 'revenue_estimate_unavailable' | null;
}

export interface TenantEconomicsResponse {
  period_yyyymm: string;
  /** JST 暦月の境界を ISO インスタントで返す（DB の TimeZone 設定に依存しない）。 */
  period_from: string;
  period_to: string;
  boundary: 'jst_calendar_month';
  /** 原価の逆算に使ったマージン倍率。後から検算できるように必ず開示する。 */
  margin_assumed: number;
  fx: ReturnType<typeof fxMeta>;
  /** 固定費按分を含まないことを構造で示す（文言だけに頼らない）。 */
  cost_basis: 'variable_only';
  tenants: TenantEconomicsRow[];
  /** 対象テナントが上限を超えて切り捨てられたか。 */
  truncated: boolean;
}

/** 売上側の唯一の出どころ。billingApi.ts から注入する（循環 import を避けるため）。 */
export interface TenantBillingSnapshot {
  plan: string | null;
  textUnits: number;
  avatarMinutes: number;
  revenueEstimateJpy: number | null;
}
export type BillingSnapshotFn = (
  db: any, tenantId: string, from: string, to: string,
) => Promise<TenantBillingSnapshot>;

/**
 * period(YYYYMM) の JST 暦月境界を ISO インスタントで返す。
 *
 * getMonthRangeJst は「now が属する月」しか返さないため、任意月へ拡張したもの。
 * 手法(+9h シフト → UTC ゲッター → -9h 戻す)は同一で、process の TZ にも
 * DB の TimeZone 設定にも依存しない。
 *
 * ★JST に揃える理由★ 込み枠画面(fetchBillingQuota)が既に JST 暦月で、
 * 売上側と原価側を同一の境界で集計しないと粗利の分子分母がズレる。
 * 既存の billingWhereClause(UTC/セッションTZ依存)は請求画面の数値が動くので触らない。
 */
export function periodToJstRangeIso(periodYyyyMm: string): { from: string; to: string } {
  if (!/^\d{6}$/.test(periodYyyyMm)) {
    throw new Error(`invalid period: ${periodYyyyMm}`);
  }
  const year = Number(periodYyyyMm.slice(0, 4));
  const month = Number(periodYyyyMm.slice(4, 6));
  if (month < 1 || month > 12) throw new Error(`invalid period: ${periodYyyyMm}`);

  // その月の中日(15日)の JST 正午を基準にすれば、getMonthRangeJst が必ず
  // 狙った月を返す(月初・月末を渡すと TZ シフトで隣の月に落ちうる)。
  const anchor = new Date(Date.UTC(year, month - 1, 15, 3, 0, 0));
  const { monthStart, monthEnd } = getMonthRangeJst(anchor);
  return { from: monthStart.toISOString(), to: monthEnd.toISOString() };
}

/**
 * マージン前原価を導出する SQL 式。
 *
 * cost_base_cents が入っている行はそれをそのまま使う（実測）。
 * 未記録の行(migration 適用前)は cost_total_cents から割り戻すが、これは
 * 原理的に不完全なので下限クランプを入れる:
 *   - marginOverride=1 で記録された end-user 機能の行は割り戻すと過小になる
 *   - cost_llm_cents はマージン非適用の実原価なので「真の原価の厳密な下限」
 * よって GREATEST(割り戻し, cost_llm_cents) を採る。
 * それでも LLM 以外(OCR/ASR 等)の原価は救えないため、estimation_method で開示する。
 *
 * ★feature_used の NULL 分岐は置かない★
 * calculateBillingAmountCents は featureUsed === undefined を end-user 扱いするが、
 * DB 側の usage_logs.feature_used は NOT NULL で(本番・CI とも実測、NULL 行 0 件)、
 * trackUsage も必須引数として受け取る。到達しない分岐を「アプリ挙動に合わせた」と
 * 書いて置くと、次に読む人が NULL がありうると誤解する。
 * 制約が外れたら billingSqlIntegration.test.ts の NOT NULL 検査が落ちるので気づける。
 */
const BASE_COST_EXPR = `
  CASE
    WHEN cost_base_cents IS NOT NULL THEN cost_base_cents
    WHEN feature_used = ANY($3::text[])
      THEN GREATEST(
             CEIL(cost_total_cents::numeric / $4::numeric),
             COALESCE(cost_llm_cents, 0)
           )
    ELSE cost_total_cents
  END`;

interface RawCostRow {
  tenant_id: string;
  total_requests: string;
  cost_base_billable: string;
  cost_base_nonbillable: string;
  recorded_rows: string;
  all_rows: string;
}

/**
 * 期間内に usage_logs 行があるテナントだけを、原価つきで返す。
 *
 * 全テナントを総なめしない(listTenantsToReconcile と同じ考え方)。
 * 利用が無いテナントは粗利を論じる対象ではなく、Stripe への往復も無駄になる。
 */
async function fetchTenantBaseCosts(
  db: any, from: string, to: string,
): Promise<RawCostRow[]> {
  const { rows } = await db.query(
    `SELECT tenant_id,
            COUNT(*)                                                  AS total_requests,
            COALESCE(SUM(${BASE_COST_EXPR}) FILTER (WHERE billable), 0)       AS cost_base_billable,
            COALESCE(SUM(${BASE_COST_EXPR}) FILTER (WHERE NOT billable), 0)   AS cost_base_nonbillable,
            COUNT(*) FILTER (WHERE cost_base_cents IS NOT NULL)       AS recorded_rows,
            COUNT(*)                                                  AS all_rows
       FROM usage_logs
      WHERE created_at >= $1::timestamptz
        AND created_at <  $2::timestamptz
      GROUP BY tenant_id
      ORDER BY 2 DESC`,
    [from, to, Array.from(END_USER_FEATURES), MARGIN_MULTIPLIER],
  );
  return rows as RawCostRow[];
}

function estimationMethodOf(recorded: number, all: number): EstimationMethod {
  if (all === 0 || recorded === all) return 'recorded';
  if (recorded === 0) return 'derived';
  return 'mixed';
}

interface CacheEntry { at: number; value: TenantEconomicsResponse }
const _cache = new Map<string, CacheEntry>();

/** テスト用。プロセス内キャッシュを捨てる。 */
export function _clearEconomicsCache(): void {
  _cache.clear();
}

/**
 * テナント横断の採算一覧。
 *
 * 売上は注入された snapshot 関数（= computeBillingEstimateJpy 経由）で1テナントずつ
 * 直列に取る。★Promise.all にしない★ — 無人 cron からの呼び出しに対して
 * 瞬間的な同時実行数を作らないため(hermes-mcp routes.ts と同じ作法)。
 */
export async function fetchTenantEconomics(
  db: any,
  periodYyyyMm: string,
  getSnapshot: BillingSnapshotFn,
): Promise<TenantEconomicsResponse> {
  const cached = _cache.get(periodYyyyMm);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const { from, to } = periodToJstRangeIso(periodYyyyMm);
  const costRows = await fetchTenantBaseCosts(db, from, to);

  const truncated = costRows.length > MAX_TENANTS_PER_ECONOMICS_REQUEST;
  const target = costRows.slice(0, MAX_TENANTS_PER_ECONOMICS_REQUEST);

  const names = new Map<string, string | null>();
  if (target.length > 0) {
    const { rows } = await db.query(
      `SELECT id, name FROM tenants WHERE id = ANY($1::text[])`,
      [target.map((r) => r.tenant_id)],
    );
    for (const r of rows) names.set(r.id, r.name ?? null);
  }

  const tenants: TenantEconomicsRow[] = [];
  for (const row of target) {
    const costBillable = Number(row.cost_base_billable);
    const costNonBillable = Number(row.cost_base_nonbillable);
    const recorded = Number(row.recorded_rows);
    const all = Number(row.all_rows);

    let snapshot: TenantBillingSnapshot = {
      plan: null, textUnits: 0, avatarMinutes: 0, revenueEstimateJpy: null,
    };
    try {
      snapshot = await getSnapshot(db, row.tenant_id, from, to);
    } catch {
      // 1テナントの Stripe 到達失敗で一覧全体を落とさない。
      // 売上は null のままになり「算出不可」として表示される(0 にはしない)。
    }

    const costBaseJpy = usdCentsToJpy(costBillable);
    const revenue = snapshot.revenueEstimateJpy;
    const grossProfitJpy =
      revenue === null || costBaseJpy === null ? null : revenue - costBaseJpy;
    const grossMarginPct =
      grossProfitJpy === null || revenue === null || revenue === 0
        ? null
        : Math.round((grossProfitJpy / revenue) * 1000) / 10;

    tenants.push({
      tenant_id: row.tenant_id,
      tenant_name: names.get(row.tenant_id) ?? null,
      plan: snapshot.plan,
      total_requests: Number(row.total_requests),
      text_units: snapshot.textUnits,
      avatar_minutes: snapshot.avatarMinutes,
      revenue_estimate_jpy: revenue,
      cost_base_usd_cents: costBillable,
      cost_base_jpy: costBaseJpy,
      cost_nonbillable_usd_cents: costNonBillable,
      cost_nonbillable_jpy: usdCentsToJpy(costNonBillable),
      gross_profit_jpy: grossProfitJpy,
      gross_margin_pct: grossMarginPct,
      estimation_method: estimationMethodOf(recorded, all),
      recorded_row_ratio: all === 0 ? 0 : Math.round((recorded / all) * 100) / 100,
      unavailable_reason: revenue === null ? 'revenue_estimate_unavailable' : null,
    });
  }

  const value: TenantEconomicsResponse = {
    period_yyyymm: periodYyyyMm,
    period_from: from,
    period_to: to,
    boundary: 'jst_calendar_month',
    margin_assumed: MARGIN_MULTIPLIER,
    fx: fxMeta(),
    cost_basis: 'variable_only',
    tenants,
    truncated,
  };
  _cache.set(periodYyyyMm, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// ドリルダウン: 推計 vs Stripe 実請求の突合
//
// ★一覧では実請求を取らない★ — テナント数ぶん Stripe を叩くことになり、
// かつ一覧の行型に実請求フィールドを置くと「取得していないので常に undefined」
// が画面で ¥0 として描かれる事故になる。突合は1テナントずつのここだけで行う。
// ---------------------------------------------------------------------------

/** 突合に使う請求書。参照のみ(Billing Portal セッションのような副作用を伴わない)。 */
export interface PeriodInvoice {
  id: string;
  /** Stripe の invoice.status。paid 以外は「確定前」として差分を出さない。 */
  status: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  /** epoch 秒 */
  period_start: number;
  period_end: number;
  hosted_invoice_url: string | null;
}

/**
 * 対象テナントの請求書を返す。
 * null は「Stripe から取得できない」(未契約 / STRIPE_SECRET_KEY 未設定)。
 * 空配列は「取得できたが該当なし」。★この2つを同じ値で表現しない★
 */
export type InvoiceFetcherFn = (db: any, tenantId: string) => Promise<PeriodInvoice[] | null>;

export type ReconcileReason =
  | 'no_subscription_or_stripe_unavailable'
  | 'no_invoice'
  | 'not_finalized'
  | 'currency_mismatch';

export interface TenantEconomicsDetail {
  row: TenantEconomicsRow;
  period_yyyymm: string;
  period_from: string;
  period_to: string;
  boundary: 'jst_calendar_month';
  margin_assumed: number;
  fx: ReturnType<typeof fxMeta>;
  cost_basis: 'variable_only';
  invoiced: {
    /** 実請求額(円)。取得できない・通貨が JPY でない場合は null。★0 にしない★ */
    amount_jpy: number | null;
    status: string | null;
    invoice_id: string | null;
    hosted_invoice_url: string | null;
    /** paid のときだけ true。false の間は差分を出さない(翌日消える乖離を追わない)。 */
    finalized: boolean;
    reason: ReconcileReason | null;
  };
  /** 実請求 − 売上推計(円)。確定前・取得不可のときは null。 */
  variance_jpy: number | null;
}

/**
 * 期間に重なる請求書を1件選ぶ。
 * Stripe の invoice の period は課金期間で、JST 暦月とは一致しないため
 * 「重なりが最大のもの」を採る(月初/月末に複数重なる場合の取り違えを防ぐ)。
 */
function pickInvoiceForPeriod(
  invoices: PeriodInvoice[], fromMs: number, toMs: number,
): PeriodInvoice | null {
  let best: PeriodInvoice | null = null;
  let bestOverlap = 0;
  for (const inv of invoices) {
    const s = inv.period_start * 1000;
    const e = inv.period_end * 1000;
    const overlap = Math.min(e, toMs) - Math.max(s, fromMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = inv;
    }
  }
  return best;
}

export async function fetchTenantEconomicsDetail(
  db: any,
  tenantId: string,
  periodYyyyMm: string,
  getSnapshot: BillingSnapshotFn,
  getInvoices: InvoiceFetcherFn | null,
): Promise<TenantEconomicsDetail | null> {
  const { from, to } = periodToJstRangeIso(periodYyyyMm);

  const { rows } = await db.query(
    `SELECT tenant_id,
            COUNT(*)                                                  AS total_requests,
            COALESCE(SUM(${BASE_COST_EXPR}) FILTER (WHERE billable), 0)       AS cost_base_billable,
            COALESCE(SUM(${BASE_COST_EXPR}) FILTER (WHERE NOT billable), 0)   AS cost_base_nonbillable,
            COUNT(*) FILTER (WHERE cost_base_cents IS NOT NULL)       AS recorded_rows,
            COUNT(*)                                                  AS all_rows
       FROM usage_logs
      WHERE created_at >= $1::timestamptz
        AND created_at <  $2::timestamptz
        AND tenant_id = $5
      GROUP BY tenant_id`,
    [from, to, Array.from(END_USER_FEATURES), MARGIN_MULTIPLIER, tenantId],
  );

  const nameRow = await db.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
  if (nameRow.rows.length === 0) return null;

  const raw: RawCostRow = rows[0] ?? {
    tenant_id: tenantId, total_requests: '0', cost_base_billable: '0',
    cost_base_nonbillable: '0', recorded_rows: '0', all_rows: '0',
  };

  let snapshot: TenantBillingSnapshot = {
    plan: null, textUnits: 0, avatarMinutes: 0, revenueEstimateJpy: null,
  };
  try {
    snapshot = await getSnapshot(db, tenantId, from, to);
  } catch {
    // 売上は null のまま(算出不可)。0 にはしない。
  }

  const costBillable = Number(raw.cost_base_billable);
  const costNonBillable = Number(raw.cost_base_nonbillable);
  const recorded = Number(raw.recorded_rows);
  const all = Number(raw.all_rows);
  const costBaseJpy = usdCentsToJpy(costBillable);
  const revenue = snapshot.revenueEstimateJpy;
  const grossProfitJpy = revenue === null || costBaseJpy === null ? null : revenue - costBaseJpy;

  const row: TenantEconomicsRow = {
    tenant_id: tenantId,
    tenant_name: nameRow.rows[0].name ?? null,
    plan: snapshot.plan,
    total_requests: Number(raw.total_requests),
    text_units: snapshot.textUnits,
    avatar_minutes: snapshot.avatarMinutes,
    revenue_estimate_jpy: revenue,
    cost_base_usd_cents: costBillable,
    cost_base_jpy: costBaseJpy,
    cost_nonbillable_usd_cents: costNonBillable,
    cost_nonbillable_jpy: usdCentsToJpy(costNonBillable),
    gross_profit_jpy: grossProfitJpy,
    gross_margin_pct:
      grossProfitJpy === null || revenue === null || revenue === 0
        ? null
        : Math.round((grossProfitJpy / revenue) * 1000) / 10,
    estimation_method: estimationMethodOf(recorded, all),
    recorded_row_ratio: all === 0 ? 0 : Math.round((recorded / all) * 100) / 100,
    unavailable_reason: revenue === null ? 'revenue_estimate_unavailable' : null,
  };

  let invoiced: TenantEconomicsDetail['invoiced'] = {
    amount_jpy: null, status: null, invoice_id: null, hosted_invoice_url: null,
    finalized: false, reason: 'no_subscription_or_stripe_unavailable',
  };
  let variance: number | null = null;

  if (getInvoices) {
    const invoices = await getInvoices(db, tenantId);
    if (invoices !== null) {
      const inv = pickInvoiceForPeriod(invoices, Date.parse(from), Date.parse(to));
      if (!inv) {
        // ★「請求書なし」であって「¥0」ではない★
        invoiced = { ...invoiced, reason: 'no_invoice' };
      } else if (inv.currency !== 'jpy') {
        // 通貨が違うものを円として突合しない(誤った差分を出すより不明を返す)。
        invoiced = {
          amount_jpy: null, status: inv.status, invoice_id: inv.id,
          hosted_invoice_url: inv.hosted_invoice_url, finalized: false,
          reason: 'currency_mismatch',
        };
      } else {
        const finalized = inv.status === 'paid';
        invoiced = {
          // JPY は Stripe のゼロ小数通貨なので /100 しない。
          amount_jpy: inv.amount_due,
          status: inv.status,
          invoice_id: inv.id,
          hosted_invoice_url: inv.hosted_invoice_url,
          finalized,
          reason: finalized ? null : 'not_finalized',
        };
        // draft/open の額で差分を出すと、翌日に消える乖離を追いかけることになる。
        if (finalized && revenue !== null) variance = inv.amount_due - revenue;
      }
    }
  }

  return {
    row,
    period_yyyymm: periodYyyyMm,
    period_from: from,
    period_to: to,
    boundary: 'jst_calendar_month',
    margin_assumed: MARGIN_MULTIPLIER,
    fx: fxMeta(),
    cost_basis: 'variable_only',
    invoiced,
    variance_jpy: variance,
  };
}
