// admin-ui/src/pages/admin/billing/upsellSuggestion.schema.test.ts
//
// ★最重要★ サーバが誤って原価入りのフィールドを返しても、パーサの戻り値に
// 一切載らないこと。ホワイトリスト方式(列挙したキーだけコピー)がこれを保証する。
import { describe, it, expect } from "vitest";
import { parseTenantUpsellResponse } from "./upsellSuggestion.schema";

describe("parseTenantUpsellResponse", () => {
  it("available:false をそのまま通す", () => {
    expect(parseTenantUpsellResponse({ available: false })).toEqual({ available: false });
  });

  it("正常なレスポンスを通す", () => {
    const r = parseTenantUpsellResponse({
      available: true, headline: "プランのご提案", lines: ["超過しています"],
    });
    expect(r).toEqual({ available: true, headline: "プランのご提案", lines: ["超過しています"] });
  });

  it("★サーバが原価フィールドを混ぜても戻り値のキー集合は固定★", () => {
    const contaminated = {
      available: true,
      headline: "プランのご提案",
      lines: ["超過しています"],
      cost_total_cents: 99999,
      gross_margin_pct: 12.3,
      margin_multiplier: 10,
    };
    const parsed = parseTenantUpsellResponse(contaminated);
    expect(Object.keys(parsed).sort()).toEqual(["available", "headline", "lines"]);
    expect(JSON.stringify(parsed)).not.toMatch(/cost|margin|profit/i);
  });

  it("available:false に余計なキーが混ざっても available だけが残る", () => {
    const parsed = parseTenantUpsellResponse({ available: false, gross_profit_jpy: 500 });
    expect(Object.keys(parsed)).toEqual(["available"]);
  });

  it("headline が文字列でなければ throw", () => {
    expect(() => parseTenantUpsellResponse({ available: true, headline: 1, lines: [] })).toThrow();
  });

  it("lines が文字列配列でなければ throw", () => {
    expect(() => parseTenantUpsellResponse({ available: true, headline: "x", lines: "not-array" })).toThrow();
    expect(() => parseTenantUpsellResponse({ available: true, headline: "x", lines: [1, 2] })).toThrow();
  });

  it("available が真偽値でなければ throw", () => {
    expect(() => parseTenantUpsellResponse({ available: "yes" })).toThrow();
  });

  it("オブジェクトでない入力は throw", () => {
    expect(() => parseTenantUpsellResponse(null)).toThrow();
    expect(() => parseTenantUpsellResponse("x")).toThrow();
  });
});
