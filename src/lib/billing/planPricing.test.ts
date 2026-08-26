// src/lib/billing/planPricing.test.ts
// プラン倍率（請求数量に乗じる係数）のテスト。
//
// ★fail-safe の向きが planFeatures.ts と逆であることを固定するのが主目的★
// 機能ゲートは「未知 → 最も制限の強い free_ad」、請求は「未知 → starter 1.0」。
// 取り違えると DB 障害時に請求が 0 円で固着する（CLAUDE.md 禁止37 / rules/billing.md §4）。

import { PLAN_MULTIPLIERS, planMultiplier } from "./planPricing";

describe("PLAN_MULTIPLIERS", () => {
  it.each([
    ["free_ad", 0],
    ["starter", 1.0],
    ["standard", 1.25],
    ["growth", 1.5],
    ["enterprise", 2.5],
  ])("%s の倍率は %s", (plan, expected) => {
    expect(planMultiplier(plan)).toBe(expected);
  });

  // .claude/rules/billing.md §7: テキスト超過は ¥20 →(×1.25) ¥25 →(×1.5) ¥30。
  // 倍率が確定価格表と整合していることを、単価の実額まで含めて固定する
  // （倍率だけ見ていると 1.25 を 1.2 に丸めても気づけない）。
  it("テキスト超過単価が確定価格(¥20/¥25/¥30)と倍率どおりに一致する", () => {
    const BASE_TEXT_PRICE_JPY = 20;
    expect(BASE_TEXT_PRICE_JPY * planMultiplier("starter")).toBe(20);
    expect(BASE_TEXT_PRICE_JPY * planMultiplier("standard")).toBe(25);
    expect(BASE_TEXT_PRICE_JPY * planMultiplier("growth")).toBe(30);
  });

  // CLAUDE.md 禁止56 / rules/billing.md §7: アバターの分単価は
  // Standard ¥100 → Growth ¥80 と倍率とは逆向きに下がる。
  // 倍率から算出すると必ず向きが反転するため、「掛けてはいけない」ことを
  // テストとして残す（次に触る人が PLAN_MULTIPLIERS を分単価に流用しないように）。
  it("アバターの分単価は倍率と逆向きなので、倍率をそのまま掛けて算出できない", () => {
    const STANDARD_AVATAR_PRICE_PER_MIN_JPY = 100;
    const GROWTH_AVATAR_PRICE_PER_MIN_JPY = 80;

    // 実際の確定価格は上位プランほど安い
    expect(GROWTH_AVATAR_PRICE_PER_MIN_JPY).toBeLessThan(STANDARD_AVATAR_PRICE_PER_MIN_JPY);
    // 一方、倍率は上位プランほど大きい（＝掛け算では再現できない）
    expect(planMultiplier("growth")).toBeGreaterThan(planMultiplier("standard"));
  });
});

describe("planMultiplier の fail-safe（請求漏れ回避方向）", () => {
  it("未知のプラン文字列は starter 相当の 1.0（0 に落として請求を消さない）", () => {
    expect(planMultiplier("typo-plan")).toBe(1.0);
    expect(planMultiplier("Standard")).toBe(1.0);
  });

  it("null / undefined は starter 1.0", () => {
    expect(planMultiplier(null)).toBe(1.0);
    expect(planMultiplier(undefined)).toBe(1.0);
  });

  it("free_ad の 0 は 1.0 にすり替わらない(?? が 0 を捕まえない性質の回帰)", () => {
    expect(planMultiplier("free_ad")).toBe(0);
  });

  it("Object.prototype 由来のキーは自前プロパティでないため 1.0 に落ちる", () => {
    expect(planMultiplier("constructor")).toBe(1.0);
    expect(planMultiplier("hasOwnProperty")).toBe(1.0);
    expect(planMultiplier("toString")).toBe(1.0);
  });

  it("standard を足しても hasOwnProperty ガードは全キーに効いている", () => {
    for (const key of Object.keys(PLAN_MULTIPLIERS)) {
      expect(planMultiplier(key)).toBe(PLAN_MULTIPLIERS[key]);
    }
  });
});
