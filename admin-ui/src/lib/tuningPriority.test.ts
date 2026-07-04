// GID 1216274385080156: 優先度スライダー(0〜10)→3段階表現の丸め込みロジック
import { describe, it, expect } from "vitest";
import { priorityToTier, PRIORITY_TIER_VALUE } from "./tuningPriority";

describe("priorityToTier", () => {
  it("0〜3は low", () => {
    expect(priorityToTier(0)).toBe("low");
    expect(priorityToTier(3)).toBe("low");
  });

  it("4〜6は normal", () => {
    expect(priorityToTier(4)).toBe("normal");
    expect(priorityToTier(5)).toBe("normal");
    expect(priorityToTier(6)).toBe("normal");
  });

  it("7〜10は high", () => {
    expect(priorityToTier(7)).toBe("high");
    expect(priorityToTier(10)).toBe("high");
  });
});

describe("PRIORITY_TIER_VALUE", () => {
  it("各段階の代表値がpriorityToTierで同じ段階に丸め込まれる（往復整合性）", () => {
    expect(priorityToTier(PRIORITY_TIER_VALUE.low)).toBe("low");
    expect(priorityToTier(PRIORITY_TIER_VALUE.normal)).toBe("normal");
    expect(priorityToTier(PRIORITY_TIER_VALUE.high)).toBe("high");
  });
});
