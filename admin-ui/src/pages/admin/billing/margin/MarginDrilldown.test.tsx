// admin-ui/src/pages/admin/billing/margin/MarginDrilldown.test.tsx
//
// ★このテストが守っているもの★
// - 正しいURL(tenantId・period・reconcile=stripe)を叩くこと
// - draft/open(未確定)の請求書では差分を出さないこと(翌日消える乖離を追わない)
// - 「請求書なし」「通貨不一致」「Stripe未設定」を ¥0 と混同しないこと
// - オーバーレイクリックで閉じること
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MarginDrilldown } from "./MarginDrilldown";

const mockAuthFetch = vi.fn();
vi.mock("../../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

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
    row: ROW, period_yyyymm: "202609",
    period_from: "2026-08-31T15:00:00.000Z", period_to: "2026-09-30T15:00:00.000Z",
    boundary: "jst_calendar_month", margin_assumed: 10,
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

beforeEach(() => vi.clearAllMocks());

describe("MarginDrilldown", () => {
  it("★正しいURL(tenantId・period・reconcile=stripe)を叩く★", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail()));
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={vi.fn()} />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    const url = mockAuthFetch.mock.calls[0]![0] as string;
    expect(url).toBe("http://localhost:3100/v1/admin/billing/economics/acme?period=202609&reconcile=stripe");
  });

  it("確定済み(paid)の請求書は実請求額と差分を表示する", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail()));
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={vi.fn()} />);
    expect(await screen.findByText(/¥23,000/)).toBeTruthy();
    expect(screen.getByText(/\+¥700/)).toBeTruthy();
  });

  it("★未確定(open等)の請求書では差分を出さない(翌日消える乖離を追わない)★", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail({
      invoiced: { amount_jpy: 23_000, status: "open", invoice_id: "in_2", hosted_invoice_url: null, finalized: false, reason: "not_finalized" },
      variance_jpy: null,
    })));
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={vi.fn()} />);
    expect(await screen.findByText("確定前")).toBeTruthy();
    expect(screen.getByText(/未確定/)).toBeTruthy();
    expect(screen.queryByText("差分(実請求 − 推計)")).toBeNull();
  });

  it("★請求書なしは「請求書なし」であって「¥0」ではない★", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail({
      invoiced: { amount_jpy: null, status: null, invoice_id: null, hosted_invoice_url: null, finalized: false, reason: "no_invoice" },
      variance_jpy: null,
    })));
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={vi.fn()} />);
    expect(await screen.findByText(/この期間の請求書はありません/)).toBeTruthy();
    expect(screen.queryByText(/¥0/)).toBeNull();
  });

  it("通貨がJPYでない請求書は比較不可として表示する", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail({
      invoiced: { amount_jpy: null, status: "paid", invoice_id: "in_3", hosted_invoice_url: null, finalized: false, reason: "currency_mismatch" },
      variance_jpy: null,
    })));
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={vi.fn()} />);
    expect(await screen.findByText(/円建てではないため比較できません/)).toBeTruthy();
  });

  it("Stripe契約情報が無い場合は突合不可を伝える", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail({
      invoiced: { amount_jpy: null, status: null, invoice_id: null, hosted_invoice_url: null, finalized: false, reason: "no_subscription_or_stripe_unavailable" },
      variance_jpy: null,
    })));
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={vi.fn()} />);
    expect(await screen.findByText(/実請求と突合できません/)).toBeTruthy();
  });

  it("取得失敗時はエラーを表示する(無限スピナーを残さない)", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(500, {}));
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={vi.fn()} />);
    expect(await screen.findByText(/取得に失敗しました/)).toBeTruthy();
  });

  it("★オーバーレイクリックで閉じる★", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail()));
    const onClose = vi.fn();
    const { container } = render(
      <MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={onClose} />,
    );
    await screen.findByText(/¥23,000/);
    fireEvent.click(container.querySelector('[role="dialog"]')!);
    expect(onClose).toHaveBeenCalled();
  });

  it("×ボタンで閉じる", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail()));
    const onClose = vi.fn();
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={onClose} />);
    await screen.findByText(/¥23,000/);
    fireEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalled();
  });

  it("tenantName が null なら tenantId を見出しに使う", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail()));
    render(<MarginDrilldown tenantId="acme" tenantName={null} periodYyyyMm="202609" onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "acme" })).toBeTruthy();
  });

  it("売上算出不可(revenue_estimate_jpy:null)は「算出不可」であって「¥0」ではない", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, detail({
      row: { ...ROW, revenue_estimate_jpy: null, gross_profit_jpy: null, gross_margin_pct: null },
    })));
    render(<MarginDrilldown tenantId="acme" tenantName="Acme" periodYyyyMm="202609" onClose={vi.fn()} />);
    expect(await screen.findByText("算出不可")).toBeTruthy();
  });
});
