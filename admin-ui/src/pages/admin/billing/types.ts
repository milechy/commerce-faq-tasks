// ─── 型定義 ────────────────────────────────────────────────
export interface Tenant {
  id: string;
  name: string;
  is_active?: boolean;
  billing_free_from?: string | null;
  billing_free_until?: string | null;
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
  amount_cents: number;
  status: "paid" | "open" | "draft";
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  portal_url: string;
}

export interface CostBreakdownItem {
  label: string;
  cost_yen: number;
  request_count: number;
  percentage: number;
}

export interface CostBreakdown {
  total_yen: number;
  breakdown: Record<string, CostBreakdownItem>;
}

export interface CrossTenantRow {
  tenant_id: string;
  total_requests: number;
  cost_total_cents: number;
}
