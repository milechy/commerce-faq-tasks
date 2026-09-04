// admin-ui/src/pages/admin/billing/margin/marginSummary.schema.ts
//
// GET /v1/admin/billing/economics のレスポンスを実行時に検証する。
//
// なぜ手書きパーサなのか:
// flowTransitions.schema.ts と同じ理由。フロントが独自定義した型を
// `as Response` でキャストすると tsc をすり抜け、本番で undefined を
// 触って画面全体がクラッシュする事故が実際に起きている。
//
// ★ここは「欠けていたら throw」する★
// テナント向けの upsellSuggestion.schema.ts は「余計なキーを落とす」ための
// ホワイトリストだが、こちらは super_admin 専用で漏洩の心配が無い代わりに
// 数値の欠落を黙って 0 として描画してはいけない(禁止20)。
// null は正当な値(算出不可)なので通し、undefined / 型違いだけを弾く。

import type {
  EstimationMethod,
  MarginSummaryResponse,
  TenantMarginRow,
} from "./types";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** null は「算出不可」という意味を持つ正当な値なので通す。undefined は弾く。 */
function nullableNumber(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (isFiniteNumber(v)) return v;
  throw new Error(`economics: ${field} が数値でも null でもありません`);
}

function nullableString(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  throw new Error(`economics: ${field} が文字列でも null でもありません`);
}

const ESTIMATION_METHODS: readonly EstimationMethod[] = ["recorded", "derived", "mixed"];

function parseRow(input: unknown, i: number): TenantMarginRow {
  if (typeof input !== "object" || input === null) {
    throw new Error(`economics: tenants[${i}] がオブジェクトではありません`);
  }
  const r = input as Record<string, unknown>;

  if (typeof r["tenant_id"] !== "string" || !r["tenant_id"]) {
    throw new Error(`economics: tenants[${i}].tenant_id が不正です`);
  }
  const method = r["estimation_method"];
  if (typeof method !== "string" || !ESTIMATION_METHODS.includes(method as EstimationMethod)) {
    throw new Error(`economics: tenants[${i}].estimation_method が不正です`);
  }
  if (!isFiniteNumber(r["total_requests"])) {
    throw new Error(`economics: tenants[${i}].total_requests が数値ではありません`);
  }
  if (!isFiniteNumber(r["cost_base_usd_cents"])) {
    throw new Error(`economics: tenants[${i}].cost_base_usd_cents が数値ではありません`);
  }

  const reason = r["unavailable_reason"];
  if (reason !== null && reason !== "revenue_estimate_unavailable") {
    throw new Error(`economics: tenants[${i}].unavailable_reason が不正です`);
  }

  return {
    tenant_id: r["tenant_id"],
    tenant_name: nullableString(r["tenant_name"], `tenants[${i}].tenant_name`),
    plan: nullableString(r["plan"], `tenants[${i}].plan`),
    total_requests: r["total_requests"],
    text_units: nullableNumber(r["text_units"], `tenants[${i}].text_units`),
    avatar_minutes: nullableNumber(r["avatar_minutes"], `tenants[${i}].avatar_minutes`),
    revenue_estimate_jpy: nullableNumber(r["revenue_estimate_jpy"], `tenants[${i}].revenue_estimate_jpy`),
    cost_base_usd_cents: r["cost_base_usd_cents"],
    cost_base_jpy: nullableNumber(r["cost_base_jpy"], `tenants[${i}].cost_base_jpy`),
    cost_nonbillable_usd_cents: isFiniteNumber(r["cost_nonbillable_usd_cents"])
      ? r["cost_nonbillable_usd_cents"]
      : 0,
    cost_nonbillable_jpy: nullableNumber(r["cost_nonbillable_jpy"], `tenants[${i}].cost_nonbillable_jpy`),
    gross_profit_jpy: nullableNumber(r["gross_profit_jpy"], `tenants[${i}].gross_profit_jpy`),
    gross_margin_pct: nullableNumber(r["gross_margin_pct"], `tenants[${i}].gross_margin_pct`),
    estimation_method: method as EstimationMethod,
    recorded_row_ratio: isFiniteNumber(r["recorded_row_ratio"]) ? r["recorded_row_ratio"] : 0,
    unavailable_reason: reason as TenantMarginRow["unavailable_reason"],
  };
}

export function parseMarginSummaryResponse(input: unknown): MarginSummaryResponse {
  if (typeof input !== "object" || input === null) {
    throw new Error("economics: レスポンスがオブジェクトではありません");
  }
  const d = input as Record<string, unknown>;

  if (typeof d["period_yyyymm"] !== "string") {
    throw new Error("economics: period_yyyymm が欠落しています");
  }
  if (!Array.isArray(d["tenants"])) {
    throw new Error("economics: tenants が配列ではありません");
  }
  if (!isFiniteNumber(d["margin_assumed"])) {
    // 倍率が分からないまま「推計原価」を描くと、後から検算できない数字になる。
    throw new Error("economics: margin_assumed が数値ではありません");
  }
  const fx = d["fx"];
  if (typeof fx !== "object" || fx === null) {
    throw new Error("economics: fx が欠落しています");
  }
  const f = fx as Record<string, unknown>;
  if (!isFiniteNumber(f["usd_jpy"])) {
    throw new Error("economics: fx.usd_jpy が数値ではありません");
  }

  return {
    period_yyyymm: d["period_yyyymm"],
    period_from: typeof d["period_from"] === "string" ? d["period_from"] : "",
    period_to: typeof d["period_to"] === "string" ? d["period_to"] : "",
    boundary: typeof d["boundary"] === "string" ? d["boundary"] : "",
    margin_assumed: d["margin_assumed"],
    fx: {
      usd_jpy: f["usd_jpy"],
      source: typeof f["source"] === "string" ? f["source"] : "unknown",
      basis: typeof f["basis"] === "string" ? f["basis"] : "unknown",
    },
    cost_basis: typeof d["cost_basis"] === "string" ? d["cost_basis"] : "unknown",
    tenants: d["tenants"].map((row, i) => parseRow(row, i)),
    // 省略時は false ではなく「切り捨てられていない」と解釈してよい
    // (サーバは常に返す。将来欠けたら一覧が不完全でも気づけないので型は boolean のまま)。
    truncated: d["truncated"] === true,
  };
}
