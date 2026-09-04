// admin-ui/src/pages/admin/billing/margin/economicsDetail.schema.ts
//
// GET /v1/admin/billing/economics/:tenantId?period=YYYYMM&reconcile=stripe
// のレスポンスを実行時に検証する(ドリルダウン: 推計 vs Stripe実請求の突合)。
//
// marginSummary.schema.ts と同じ理由で手書きパーサ。「欠けていたら throw」
// する方針も同じ(super_admin専用で漏洩の心配は無い代わりに、欠落を黙って
// 0/¥0として描画してはいけない — 禁止20)。row の検証は marginSummary.schema.ts
// の parseRow を再利用し、同じ検証を2箇所に書き写さない。

import { parseRow } from "./marginSummary.schema";
import type { TenantMarginRow } from "./types";

export type ReconcileReason =
  | "no_subscription_or_stripe_unavailable"
  | "no_invoice"
  | "not_finalized"
  | "currency_mismatch";

const RECONCILE_REASONS: readonly ReconcileReason[] = [
  "no_subscription_or_stripe_unavailable", "no_invoice", "not_finalized", "currency_mismatch",
];

export interface InvoicedInfo {
  /** 実請求額(円)。取得できない・通貨がJPYでない・確定前は null。★0にしない★ */
  amount_jpy: number | null;
  status: string | null;
  invoice_id: string | null;
  hosted_invoice_url: string | null;
  /** paid のときだけ true。false の間は差分(variance_jpy)を出さない。 */
  finalized: boolean;
  reason: ReconcileReason | null;
}

export interface TenantEconomicsDetailResponse {
  row: TenantMarginRow;
  period_yyyymm: string;
  period_from: string;
  period_to: string;
  boundary: string;
  margin_assumed: number;
  fx: { usd_jpy: number; source: string; basis: string };
  cost_basis: string;
  invoiced: InvoicedInfo;
  /** 実請求 − 売上推計(円)。確定前・取得不可のときは null。★0にしない★ */
  variance_jpy: number | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function nullableNumber(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (isFiniteNumber(v)) return v;
  throw new Error(`economics-detail: ${field} が数値でも null でもありません`);
}

function nullableString(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v === "string") return v;
  throw new Error(`economics-detail: ${field} が文字列でも null でもありません`);
}

function parseInvoiced(input: unknown): InvoicedInfo {
  if (typeof input !== "object" || input === null) {
    throw new Error("economics-detail: invoiced が欠落しています");
  }
  const r = input as Record<string, unknown>;
  const reason = r["reason"];
  if (reason !== null && !RECONCILE_REASONS.includes(reason as ReconcileReason)) {
    throw new Error("economics-detail: invoiced.reason が不正です");
  }
  if (typeof r["finalized"] !== "boolean") {
    throw new Error("economics-detail: invoiced.finalized が真偽値ではありません");
  }
  return {
    amount_jpy: nullableNumber(r["amount_jpy"], "invoiced.amount_jpy"),
    status: nullableString(r["status"], "invoiced.status"),
    invoice_id: nullableString(r["invoice_id"], "invoiced.invoice_id"),
    hosted_invoice_url: nullableString(r["hosted_invoice_url"], "invoiced.hosted_invoice_url"),
    finalized: r["finalized"],
    reason: reason as ReconcileReason | null,
  };
}

export function parseEconomicsDetailResponse(input: unknown): TenantEconomicsDetailResponse {
  if (typeof input !== "object" || input === null) {
    throw new Error("economics-detail: レスポンスがオブジェクトではありません");
  }
  const d = input as Record<string, unknown>;

  if (typeof d["period_yyyymm"] !== "string") {
    throw new Error("economics-detail: period_yyyymm が欠落しています");
  }
  if (!isFiniteNumber(d["margin_assumed"])) {
    throw new Error("economics-detail: margin_assumed が数値ではありません");
  }
  const fx = d["fx"];
  if (typeof fx !== "object" || fx === null) {
    throw new Error("economics-detail: fx が欠落しています");
  }
  const f = fx as Record<string, unknown>;
  if (!isFiniteNumber(f["usd_jpy"])) {
    throw new Error("economics-detail: fx.usd_jpy が数値ではありません");
  }

  return {
    row: parseRow(d["row"], 0),
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
    invoiced: parseInvoiced(d["invoiced"]),
    variance_jpy: nullableNumber(d["variance_jpy"], "variance_jpy"),
  };
}
