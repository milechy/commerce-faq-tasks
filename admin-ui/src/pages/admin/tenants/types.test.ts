import { describe, it, expect } from "vitest";
import { PLAN_OPTIONS } from "./types";

describe("PLAN_OPTIONS", () => {
  it("free_ad エントリを含む", () => {
    const freeAd = PLAN_OPTIONS.find((p) => p.value === "free_ad");
    expect(freeAd).toBeDefined();
  });

  it("free_ad の multiplier は 0(広告原資の無料プラン)である", () => {
    const freeAd = PLAN_OPTIONS.find((p) => p.value === "free_ad");
    expect(freeAd?.multiplier).toBe(0);
  });

  it("free_ad のラベルは「Free（広告表示）」である", () => {
    const freeAd = PLAN_OPTIONS.find((p) => p.value === "free_ad");
    expect(freeAd?.label).toBe("Free（広告表示）");
  });

  it("free_ad の説明文はバッジ表示・月200会話上限に言及している", () => {
    const freeAd = PLAN_OPTIONS.find((p) => p.value === "free_ad");
    expect(freeAd?.desc).toContain("Powered by R2C");
    expect(freeAd?.desc).toContain("200");
  });

  it("free_ad は starter より下(最下段)の並び順である", () => {
    const values = PLAN_OPTIONS.map((p) => p.value);
    expect(values.indexOf("free_ad")).toBeLessThan(values.indexOf("starter"));
  });

  it("全プラン(free_ad/starter/standard/growth/enterprise)が揃っている", () => {
    const values = PLAN_OPTIONS.map((p) => p.value);
    expect(values).toEqual(["free_ad", "starter", "standard", "growth", "enterprise"]);
  });
});

// PLAN_OPTIONS はテナントが実際にプランを選ぶ画面(PlanSection / BillingSection)の
// 唯一の情報源。ここに standard が無いと、backend の planValues・PLAN_RANK・
// CHECK 制約を全て直しても誰も Standard を選べない(CLAUDE.md 禁止15「作った」と「届いた」は別)。
describe("PLAN_OPTIONS — Standard(¥9,800)", () => {
  const standard = () => PLAN_OPTIONS.find((p) => p.value === "standard");

  it("standard エントリを含む(テナントが選べる導線がある)", () => {
    expect(standard()).toBeDefined();
  });

  it("standard の multiplier は 1.25(backend PLAN_MULTIPLIERS と一致)", () => {
    expect(standard()?.multiplier).toBe(1.25);
  });

  it("standard のラベルは「Standard」である", () => {
    expect(standard()?.label).toBe("Standard");
  });

  // 「アバターは使えるがカスタムはできない」がこのプランの商品性そのもの。
  // 説明文がこれを伝えないと、Growth を期待して契約する誤解が起きる。
  it("standard の説明文は「既定アバター利用可・カスタム不可」と月額を明示する", () => {
    const desc = standard()?.desc ?? "";
    expect(desc).toContain("既定アバター");
    expect(desc).toContain("カスタム不可");
    expect(desc).toContain("9,800");
  });

  it("standard は starter と growth の間の並び順である", () => {
    const values = PLAN_OPTIONS.map((p) => p.value);
    expect(values.indexOf("starter")).toBeLessThan(values.indexOf("standard"));
    expect(values.indexOf("standard")).toBeLessThan(values.indexOf("growth"));
  });

  it("倍率は starter < standard < growth < enterprise の順に単調増加する", () => {
    const m = (v: string) => PLAN_OPTIONS.find((p) => p.value === v)?.multiplier ?? NaN;
    expect(m("starter")).toBeLessThan(m("standard"));
    expect(m("standard")).toBeLessThan(m("growth"));
    expect(m("growth")).toBeLessThan(m("enterprise"));
  });
});
