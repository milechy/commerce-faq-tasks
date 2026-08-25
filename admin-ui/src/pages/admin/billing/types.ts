import type { TenantPlan } from "../../../auth/useAuth";

// ─── 型定義 ────────────────────────────────────────────────
export interface Tenant {
  id: string;
  name: string;
  is_active?: boolean;
  billing_free_from?: string | null;
  billing_free_until?: string | null;
  // GET /v1/admin/tenants の一覧応答に含まれる(src/api/admin/tenants/routes.ts の
  // SELECT に t.plan がある)。super_admin のプラン表示はここから引く。個別取得はしない。
  plan?: TenantPlan | null;
}

export interface BillingAdjustment {
  id: number;
  amount: number;
  reason: string;
  adjusted_by: string;
  created_at: string;
}

export interface BillingSummary {
  tenant_id: string;
  month: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cost_llm_cents: number;
  cost_total_cents: number;
  billing_status: "pending" | "invoiced" | "error";
  // PR-5(2026-08-25収益監査): Stripe実単価(billedQuantity × 実単価)ベースの見積り(円)。
  // cost_total_cents(原価×マージン倍率、USD)とは別の数式。算出不可(価格未設定等)ならnull
  // — 0円は「今月は無料」に読めてしまうため区別する。
  billing_estimate_jpy: number | null;
}

export interface DailyUsage {
  date: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_total_cents: number;
}

export interface Invoice {
  id: string;
  month: string;
  // PR-5: Stripeの請求はJPY建て(JPYはStripe上ゼロ小数通貨=最小単位がそのまま円)。
  // 旧名 amount_cents のまま /100 していたため実額の1/100で表示されていた。
  amount_jpy: number;
  status: "paid" | "open" | "draft";
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  portal_url: string;
}

export interface CostBreakdownItem {
  label: string;
  // PR-5: 原価(costCalculator.ts、USD建て)の機能別構成比。Stripeは機能別に請求を
  // 分けないため実単価ベースにはできない。旧名 cost_yen は無変換のまま¥表示していた。
  cost_usd: number;
  request_count: number;
  percentage: number;
}

export interface CostBreakdown {
  total_usd: number;
  breakdown: Record<string, CostBreakdownItem>;
}

export interface CrossTenantRow {
  tenant_id: string;
  total_requests: number;
  cost_total_cents: number;
}
