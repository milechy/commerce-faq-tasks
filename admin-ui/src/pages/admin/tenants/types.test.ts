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

  it("全プラン(free_ad/starter/growth/enterprise)が揃っている", () => {
    const values = PLAN_OPTIONS.map((p) => p.value);
    expect(values).toEqual(["free_ad", "starter", "growth", "enterprise"]);
  });
});
