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

describe('parseTenantUpsellResponse — イレギュラー操作', () => {
  it('★__proto__ キーを含むレスポンスでも Object.prototype を汚染しない★', () => {
    const malicious = JSON.parse(
      `{"available":true,"headline":"x","lines":["a"],"__proto__":{"polluted":"yes"}}`
    );
    parseTenantUpsellResponse(malicious);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('lines が巨大配列(10000件)でも処理できる(DoS耐性の最低限)', () => {
    const many = Array.from({ length: 10000 }, (_, i) => `line-${i}`);
    const result = parseTenantUpsellResponse({ available: true, headline: 'x', lines: many });
    expect(result).toEqual({ available: true, headline: 'x', lines: many });
  });

  it('lines が空配列でも通す(見出しだけの状態はサーバの責務、パーサは拒否しない)', () => {
    expect(parseTenantUpsellResponse({ available: true, headline: 'x', lines: [] }))
      .toEqual({ available: true, headline: 'x', lines: [] });
  });

  it('available が数値の1(truthy値だが真偽値でない)なら throw する(暗黙変換しない)', () => {
    expect(() => parseTenantUpsellResponse({ available: 1, headline: 'x', lines: [] })).toThrow();
  });

  it('available が文字列"true"なら throw する', () => {
    expect(() => parseTenantUpsellResponse({ available: 'true', headline: 'x', lines: [] })).toThrow();
  });

  it('headline が空文字でも throw しない(サーバが意図的に空を返す可能性を排除しない)', () => {
    expect(() => parseTenantUpsellResponse({ available: true, headline: '', lines: [] })).not.toThrow();
  });

  it('lines 内に空文字が混ざっても通す', () => {
    const result = parseTenantUpsellResponse({ available: true, headline: 'x', lines: ['a', '', 'c'] });
    expect(result).toEqual({ available: true, headline: 'x', lines: ['a', '', 'c'] });
  });

  it('配列そのものが渡されたら(オブジェクトでない) throw する', () => {
    expect(() => parseTenantUpsellResponse([])).toThrow();
  });

  it('available:true かつ headline/lines が両方欠落していれば throw する(headline優先で検出)', () => {
    expect(() => parseTenantUpsellResponse({ available: true })).toThrow(/headline/);
  });
});
