// admin-ui/src/pages/admin/billing/margin/types.ts
//
// GET /v1/admin/billing/economics のレスポンス契約。
//
// ★このディレクトリは super_admin 専用★
// ここの型は原価・マージン倍率・粗利を含む。テナントに描画される面
// (TenantUpsellNotice 等)から import しないこと。テナント向けの型は
// billing/upsellTypes.ts に別に置く(親型を作って共有しない)。
//
// ■ 単位の規約(billing/types.ts から継承)
//   *_usd_cents ... USDセント(原価。costCalculator 由来)。表示は fmtCents → $
//   *_jpy       ... 円(Stripe はゼロ小数通貨なので /100 しない)。表示は fmtJpy → ¥
//   *_jpy_converted ... 為替換算した円。表示は fmtJpyConverted → ≈¥
//                       ★実額の円と混ぜない★ レートは固定値の概算。

/** 原価の確からしさ。移行期に「どこまで実測でどこから推計か」を開示する。 */
export type EstimationMethod = "recorded" | "derived" | "mixed";

/**
 * 横断一覧の1行。
 *
 * ★invoiced_amount_jpy を足してはいけない★
 * 一覧では実請求を取得しないため常に undefined になり、画面が「¥0」を
 * 描く事故になる(禁止20)。突合はドリルダウン専用の型で扱う。
 */
export interface TenantMarginRow {
  tenant_id: string;
  tenant_name: string | null;
  plan: string | null;
  /** usage_logs の行数。課金単位の会話数ではない(それは text_units)。 */
  total_requests: number;
  text_units: number | null;
  avatar_minutes: number | null;
  /** 売上「推計」。算出不可(enterprise / Stripe未設定など)は null。★0 にしない★ */
  revenue_estimate_jpy: number | null;
  /** 課金対象のAPI原価(USDセント、マージン前)。 */
  cost_base_usd_cents: number;
  /** 上を為替換算した円。レートは固定値の概算なので実額と混ぜない。 */
  cost_base_jpy: number | null;
  /** 非課金機能(admin_tuning / sai_agent 等)の原価。粗利からは外して別に見せる。 */
  cost_nonbillable_usd_cents: number;
  cost_nonbillable_jpy: number | null;
  /** 売上推計 − 課金対象の原価。売上が null なら null。★0 にしない★ */
  gross_profit_jpy: number | null;
  gross_margin_pct: number | null;
  estimation_method: EstimationMethod;
  recorded_row_ratio: number;
  unavailable_reason: "revenue_estimate_unavailable" | null;

  /**
   * 固定費按分(アバター基盤・VPS等)。★今回スコープ外のため常に undefined★
   * サーバが返し始めたら MARGIN_COLUMNS に1行足すだけで列が出る。
   * gross_* と別名にしてあるのは、粗利と営業利益を同じ語で呼ばないため。
   */
  allocated_fixed_cost_jpy?: number | null;
  operating_profit_jpy?: number | null;
}

export interface MarginFxMeta {
  usd_jpy: number;
  source: string;
  /** 固定レートによる概算であることを構造で示す(文言だけに頼らない)。 */
  basis: string;
}

export interface MarginSummaryResponse {
  period_yyyymm: string;
  /** JST 暦月の境界(ISO インスタント)。DB の TimeZone 設定に依存しない。 */
  period_from: string;
  period_to: string;
  boundary: string;
  /** 原価の逆算に使ったマージン倍率。後から検算できるよう必ず表示する。 */
  margin_assumed: number;
  fx: MarginFxMeta;
  /** "variable_only" = 固定費按分を含まない。 */
  cost_basis: string;
  tenants: TenantMarginRow[];
  /** 対象テナントが上限を超えて切り捨てられたか。黙って切らない。 */
  truncated: boolean;
}
