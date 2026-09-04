// admin-ui/src/pages/admin/billing/margin/economicsDetail.schema.test.ts
import { describe, it, expect } from "vitest";
import { parseEconomicsDetailResponse } from "./economicsDetail.schema";

const ROW = {
  tenant_id: "acme", tenant_name: "Acme", plan: "standard",
  total_requests: 1200, text_units: 1500, avatar_minutes: 40,
  revenue_estimate_jpy: 22_300, cost_base_usd_cents: 1000, cost_base_jpy: 1500,
  cost_nonbillable_usd_cents: 0, cost_nonbillable_jpy: 0,
  gross_profit_jpy: 20_800, gross_margin_pct: 93.3,
  estimation_method: "recorded", recorded_row_ratio: 1, unavailable_reason: null,
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    row: ROW,
    period_yyyymm: "202609",
    period_from: "2026-08-31T15:00:00.000Z",
    period_to: "2026-09-30T15:00:00.000Z",
    boundary: "jst_calendar_month",
    margin_assumed: 10,
    fx: { usd_jpy: 150, source: "default", basis: "fixed_rate_estimate" },
    cost_basis: "variable_only",
    invoiced: {
      amount_jpy: 23_000, status: "paid", invoice_id: "in_1", hosted_invoice_url: "https://stripe.example/in_1",
      finalized: true, reason: null,
    },
    variance_jpy: 700,
    ...overrides,
  };
}

describe("parseEconomicsDetailResponse", () => {
  it("正常系: row と invoiced をパースする", () => {
    const r = parseEconomicsDetailResponse(detail());
    expect(r.row.tenant_id).toBe("acme");
    expect(r.invoiced.amount_jpy).toBe(23_000);
    expect(r.invoiced.finalized).toBe(true);
    expect(r.variance_jpy).toBe(700);
  });

  it("★invoiced.reason='no_invoice' でも amount_jpy は null のまま通る(¥0にしない)★", () => {
    const r = parseEconomicsDetailResponse(detail({
      invoiced: { amount_jpy: null, status: null, invoice_id: null, hosted_invoice_url: null, finalized: false, reason: "no_invoice" },
      variance_jpy: null,
    }));
    expect(r.invoiced.amount_jpy).toBeNull();
    expect(r.invoiced.reason).toBe("no_invoice");
    expect(r.variance_jpy).toBeNull();
  });

  it("未確定(finalized:false)は variance_jpy が null でも通る(差分を出さない設計を許容)", () => {
    const r = parseEconomicsDetailResponse(detail({
      invoiced: { amount_jpy: 23_000, status: "open", invoice_id: "in_2", hosted_invoice_url: null, finalized: false, reason: "not_finalized" },
      variance_jpy: null,
    }));
    expect(r.invoiced.finalized).toBe(false);
    expect(r.variance_jpy).toBeNull();
  });

  it("invoiced.reason が不正な値なら throw", () => {
    expect(() => parseEconomicsDetailResponse(detail({
      invoiced: { amount_jpy: null, status: null, invoice_id: null, hosted_invoice_url: null, finalized: false, reason: "bogus" },
    }))).toThrow();
  });

  it("invoiced.finalized が真偽値でなければ throw", () => {
    expect(() => parseEconomicsDetailResponse(detail({
      invoiced: { amount_jpy: null, status: null, invoice_id: null, hosted_invoice_url: null, finalized: "yes", reason: null },
    }))).toThrow();
  });

  it("invoiced が欠落していれば throw", () => {
    const { invoiced: _i, ...rest } = detail();
    void _i;
    expect(() => parseEconomicsDetailResponse(rest)).toThrow();
  });

  it("row が欠落していれば throw(marginSummary.schema の parseRow に委譲)", () => {
    const { row: _r, ...rest } = detail();
    void _r;
    expect(() => parseEconomicsDetailResponse(rest)).toThrow();
  });

  it("margin_assumed が数値でなければ throw", () => {
    expect(() => parseEconomicsDetailResponse(detail({ margin_assumed: "x" }))).toThrow();
  });

  it("オブジェクトでない入力は throw", () => {
    expect(() => parseEconomicsDetailResponse(null)).toThrow();
  });
});
