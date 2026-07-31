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

  // 壊れやすいポイント: API側のzodスキーマ(src/api/admin/tuning/routes.ts)は
  // priorityを-100〜100まで許容しており、この関数が想定する0〜10の範囲と
  // 一致していない(既知の値域不一致、D5)。是正前の現状でも、範囲外の値が
  // 来て例外を投げたり想定外の段階に丸め込まれたりしないことを固定しておく。
  it("値域外(負数・10超)でも例外を投げず、閾値どおりの段階に丸め込む(D5是正前の防御)", () => {
    expect(priorityToTier(-100)).toBe("low");
    expect(priorityToTier(-1)).toBe("low");
    expect(priorityToTier(11)).toBe("high");
    expect(priorityToTier(100)).toBe("high");
  });
});

describe("PRIORITY_TIER_VALUE", () => {
  it("各段階の代表値がpriorityToTierで同じ段階に丸め込まれる（往復整合性）", () => {
    expect(priorityToTier(PRIORITY_TIER_VALUE.low)).toBe("low");
    expect(priorityToTier(PRIORITY_TIER_VALUE.normal)).toBe("normal");
    expect(priorityToTier(PRIORITY_TIER_VALUE.high)).toBe("high");
  });
});
