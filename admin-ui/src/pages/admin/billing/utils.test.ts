import { describe, it, expect } from "vitest";
import { fmtPlanMultiplier } from "./utils";
import { PLAN_OPTIONS } from "../tenants/types";

// ★倍率はテナントへの請求単価そのものなので、丸めて実際と違う数字を出さない★
// 従来の toFixed(1) 直書きのままだと Standard(×1.25)が「×1.3」と表示され、
// 画面の説明と実請求が食い違う(CLAUDE.md 禁止54 / 禁止48)。
describe("fmtPlanMultiplier", () => {
  it("既存プランの見た目は1桁のまま変わらない", () => {
    expect(fmtPlanMultiplier(0)).toBe("0.0");
    expect(fmtPlanMultiplier(1.0)).toBe("1.0");
    expect(fmtPlanMultiplier(1.5)).toBe("1.5");
    expect(fmtPlanMultiplier(2.5)).toBe("2.5");
  });

  it("小数第2位が必要な倍率は切り捨て・四捨五入せず2桁で出す", () => {
    expect(fmtPlanMultiplier(1.25)).toBe("1.25");
    expect(fmtPlanMultiplier(1.25)).not.toBe("1.3");
  });

  // PLAN_OPTIONS に将来どんな倍率が入っても、表示が実値と乖離しないことを固定する。
  it("PLAN_OPTIONS の全倍率が、表示文字列を数値に戻すと元の値と一致する", () => {
    for (const opt of PLAN_OPTIONS) {
      expect(Number(fmtPlanMultiplier(opt.multiplier))).toBe(opt.multiplier);
    }
  });
});
