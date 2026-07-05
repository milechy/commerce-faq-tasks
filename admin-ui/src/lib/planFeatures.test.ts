import { describe, it, expect } from "vitest";
import { planHasFeature } from "./planFeatures";

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
  ] as const)("%s プランで %s = %s", (plan, feature, expected) => {
    expect(planHasFeature(plan, feature)).toBe(expected);
  });

  it("plan=null(未取得)は常にfalse(fail-safe)", () => {
    expect(planHasFeature(null, "avatar")).toBe(false);
    expect(planHasFeature(null, "conversion")).toBe(false);
  });
});
