// admin-ui/src/pages/admin/billing/TenantUpsellNotice.test.tsx
//
// ★このテストが守っているもの★
// サーバが cost_total_cents / margin_multiplier / gross_profit_jpy 等を
// 誤って返しても、DOM に一切現れないこと。パーサのホワイトリストと
// このコンポーネントが「展開せず必要なフィールドだけ読む」設計の
// 二重の防御が、実際に効いているかをここで固定する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TenantUpsellNotice } from "./TenantUpsellNotice";

const mockAuthFetch = vi.fn();
vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

beforeEach(() => vi.clearAllMocks());

describe("TenantUpsellNotice", () => {
  it("available:true なら見出しと本文を描画する", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      available: true, headline: "プランのご提案", lines: ["超過しています", "ご検討ください"],
    }));
    render(<TenantUpsellNotice />);
    expect(await screen.findByText("プランのご提案")).toBeTruthy();
    expect(screen.getByText("超過しています")).toBeTruthy();
    expect(screen.getByText("ご検討ください")).toBeTruthy();
  });

  it("★サーバが原価入りのレスポンスを返しても DOM に一切現れない★", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, {
      available: true,
      headline: "プランのご提案",
      lines: ["超過しています"],
      // 誤って混入した想定の原価フィールド群
      cost_total_cents: 12345,
      gross_profit_jpy: 6789,
      gross_margin_pct: 42.5,
      margin_multiplier: 10,
      cost_base_jpy: 999,
    }));
    const { container } = render(<TenantUpsellNotice />);
    await screen.findByText("プランのご提案");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/12345|6789|42\.5|原価|粗利|マージン|倍率|\$\d/);
  });

  it("available:false なら何も描画しない", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { available: false }));
    const { container } = render(<TenantUpsellNotice />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("取得失敗時は何も描画しない(他機能に影響させない)", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(500, {}));
    const { container } = render(<TenantUpsellNotice />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("契約違反のレスポンスでもクラッシュしない(何も描画しない)", async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { available: true, headline: 123 }));
    const { container } = render(<TenantUpsellNotice />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("ネットワーク例外でもクラッシュしない", async () => {
    mockAuthFetch.mockRejectedValue(new Error("network down"));
    const { container } = render(<TenantUpsellNotice />);
    await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
