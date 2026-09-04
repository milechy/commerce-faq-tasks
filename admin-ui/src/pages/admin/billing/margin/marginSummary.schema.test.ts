// admin-ui/src/pages/admin/billing/margin/marginSummary.schema.test.ts
//
// ★null(算出不可) と undefined(契約違反) を区別することがこのパーサの要★
// null を弾くと enterprise テナントで画面が落ち、undefined を通すと
// 「算出不可」が「¥0」として描かれる(禁止20)。
import { describe, it, expect } from "vitest";
import { parseMarginSummaryResponse } from "./marginSummary.schema";

const ROW = {
  tenant_id: "acme", tenant_name: "Acme", plan: "standard",
  total_requests: 10, text_units: 5, avatar_minutes: 0,
  revenue_estimate_jpy: 1000, cost_base_usd_cents: 100, cost_base_jpy: 150,
  cost_nonbillable_usd_cents: 0, cost_nonbillable_jpy: 0,
  gross_profit_jpy: 850, gross_margin_pct: 85,
  estimation_method: "recorded", recorded_row_ratio: 1, unavailable_reason: null,
};
const OK = {
  period_yyyymm: "202609", period_from: "x", period_to: "y",
  boundary: "jst_calendar_month", margin_assumed: 10,
  fx: { usd_jpy: 150, source: "default", basis: "fixed_rate_estimate" },
  cost_basis: "variable_only", tenants: [ROW], truncated: false,
};

describe("parseMarginSummaryResponse", () => {
  it("正常なレスポンスを通す", () => {
    expect(parseMarginSummaryResponse(OK).tenants[0]!.tenant_id).toBe("acme");
  });

  it("★null は「算出不可」として通す（enterprise で落とさない）★", () => {
    const r = parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, revenue_estimate_jpy: null, gross_profit_jpy: null, gross_margin_pct: null }],
    });
    expect(r.tenants[0]!.revenue_estimate_jpy).toBeNull();
    expect(r.tenants[0]!.gross_profit_jpy).toBeNull();
  });

  it("★undefined は契約違反として throw する（0 として描かせない）★", () => {
    const { revenue_estimate_jpy, ...withoutRevenue } = ROW;
    void revenue_estimate_jpy;
    expect(() => parseMarginSummaryResponse({ ...OK, tenants: [withoutRevenue] })).toThrow();
  });

  it("文字列が来た数値フィールドも throw する", () => {
    expect(() => parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, gross_profit_jpy: "850" }],
    })).toThrow();
  });

  it("margin_assumed が欠けたら throw（検算できない数字を描かない）", () => {
    const { margin_assumed, ...without } = OK;
    void margin_assumed;
    expect(() => parseMarginSummaryResponse(without)).toThrow(/margin_assumed/);
  });

  it("fx.usd_jpy が欠けたら throw（換算レート不明のまま円を出さない）", () => {
    expect(() => parseMarginSummaryResponse({ ...OK, fx: { source: "x" } })).toThrow(/usd_jpy/);
  });

  it("tenants が配列でなければ throw", () => {
    expect(() => parseMarginSummaryResponse({ ...OK, tenants: "nope" })).toThrow(/tenants/);
  });

  it("未知の estimation_method は throw（黙って表示しない）", () => {
    expect(() => parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, estimation_method: "guessed" }],
    })).toThrow(/estimation_method/);
  });

  it("オブジェクトでない入力は throw", () => {
    expect(() => parseMarginSummaryResponse(null)).toThrow();
    expect(() => parseMarginSummaryResponse("x")).toThrow();
  });
});

describe('parseMarginSummaryResponse — イレギュラー操作・prototype pollution', () => {
  const ROW = {
    tenant_id: 'acme', tenant_name: 'Acme', plan: 'standard',
    total_requests: 10, text_units: 5, avatar_minutes: 0,
    revenue_estimate_jpy: 1000, cost_base_usd_cents: 100, cost_base_jpy: 150,
    cost_nonbillable_usd_cents: 0, cost_nonbillable_jpy: 0,
    gross_profit_jpy: 850, gross_margin_pct: 85,
    estimation_method: 'recorded', recorded_row_ratio: 1, unavailable_reason: null,
  };
  const OK = {
    period_yyyymm: '202609', period_from: 'x', period_to: 'y',
    boundary: 'jst_calendar_month', margin_assumed: 10,
    fx: { usd_jpy: 150, source: 'default', basis: 'fixed_rate_estimate' },
    cost_basis: 'variable_only', tenants: [ROW], truncated: false,
  };

  it('★JSON.parse された __proto__ キーで Object.prototype を汚染しない★', () => {
    // JSON.parse('{"__proto__":{"polluted":true}}') は通常のオブジェクトプロパティとして
    // __proto__ を持つ(プロトタイプチェーンには影響しない)が、コピー方法によっては
    // 汚染しうる。ここでは実際に汚染が起きないことを確認する。
    const malicious = JSON.parse(
      `{"tenant_id":"acme","tenant_name":"x","plan":"standard","total_requests":1,` +
      `"text_units":1,"avatar_minutes":0,"revenue_estimate_jpy":1,"cost_base_usd_cents":1,` +
      `"cost_base_jpy":1,"cost_nonbillable_usd_cents":0,"cost_nonbillable_jpy":0,` +
      `"gross_profit_jpy":1,"gross_margin_pct":1,"estimation_method":"recorded",` +
      `"recorded_row_ratio":1,"unavailable_reason":null,"__proto__":{"polluted":"yes"}}`
    );
    parseMarginSummaryResponse({ ...OK, tenants: [malicious] });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('tenants 配列に大量の行(1000件)があっても例外を投げず処理できる', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...ROW, tenant_id: `t${i}` }));
    const result = parseMarginSummaryResponse({ ...OK, tenants: many });
    expect(result.tenants).toHaveLength(1000);
  });

  it('margin_assumed が負の値でも(異常値だが型は数値)通す — 意味検証はしない範囲', () => {
    expect(() => parseMarginSummaryResponse({ ...OK, margin_assumed: -1 })).not.toThrow();
  });

  it('recorded_row_ratio が 1 を超える異常値でも throw せず素通しする(範囲検証はサーバ側の責務)', () => {
    const result = parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, recorded_row_ratio: 1.5 }],
    });
    expect(result.tenants[0]!.recorded_row_ratio).toBe(1.5);
  });

  it('★tenant_id が空文字なら throw する(実装済みの防御を確認)★', () => {
    expect(() => parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, tenant_id: '' }],
    })).toThrow();
  });

  it('estimation_method に prototype チェーン由来の値(toString等)が来ても throw する', () => {
    expect(() => parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, estimation_method: 'toString' }],
    })).toThrow();
  });

  it('数値フィールドに文字列化された数値("100")が来たら throw する(暗黙の型変換をしない)', () => {
    expect(() => parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, cost_base_usd_cents: '100' }],
    })).toThrow();
  });

  it('数値フィールドに NaN が来たら throw する(Number.isFinite(NaN)===falseの経路)', () => {
    expect(() => parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, gross_profit_jpy: NaN }],
    })).toThrow();
  });

  it('数値フィールドに Infinity が来たら throw する', () => {
    expect(() => parseMarginSummaryResponse({
      ...OK, tenants: [{ ...ROW, cost_base_usd_cents: Infinity }],
    })).toThrow();
  });
});
