import { describe, it, expect } from "vitest";
import { planHasFeature, isPlanUpgradeRequired } from "./planFeatures";

describe("planHasFeature", () => {
  it.each([
    ["starter", "avatar", false],
    ["growth", "avatar", true],
    ["enterprise", "avatar", true],
    ["starter", "voice_clone", false],
    ["growth", "voice_clone", false],
    ["enterprise", "voice_clone", true],
    ["starter", "analytics", false],
    ["growth", "analytics", true],
    ["starter", "conversion", false],
    ["growth", "conversion", true],
    ["starter", "deep_research", false],
    ["growth", "deep_research", false],
    ["enterprise", "deep_research", true],
    ["starter", "premium_avatar", false],
    ["growth", "premium_avatar", true],
    ["enterprise", "premium_avatar", true],
    ["starter", "sai_task", false],
    ["growth", "sai_task", false],
    ["enterprise", "sai_task", true],
    ["starter", "pre_dispatch", false],
    ["growth", "pre_dispatch", false],
    ["enterprise", "pre_dispatch", true],
  ] as const)("%s プランで %s = %s", (plan, feature, expected) => {
    expect(planHasFeature(plan, feature)).toBe(expected);
  });

  it("plan=null(未取得)は常にfalse(fail-safe)", () => {
    expect(planHasFeature(null, "avatar")).toBe(false);
    expect(planHasFeature(null, "conversion")).toBe(false);
  });
});

describe("isPlanUpgradeRequired", () => {
  it("error: plan_upgrade_required の本文で true", () => {
    expect(isPlanUpgradeRequired({ error: "plan_upgrade_required", message: "..." })).toBe(true);
  });

  it("他のerror文字列では false", () => {
    expect(isPlanUpgradeRequired({ error: "not_found" })).toBe(false);
    expect(isPlanUpgradeRequired({ error: "forbidden" })).toBe(false);
  });

  it("null / undefined / 非オブジェクトでは false(例外を投げない)", () => {
    expect(isPlanUpgradeRequired(null)).toBe(false);
    expect(isPlanUpgradeRequired(undefined)).toBe(false);
    expect(isPlanUpgradeRequired("plan_upgrade_required")).toBe(false);
    expect(isPlanUpgradeRequired(42)).toBe(false);
  });

  it("空オブジェクトでは false", () => {
    expect(isPlanUpgradeRequired({})).toBe(false);
  });
});
