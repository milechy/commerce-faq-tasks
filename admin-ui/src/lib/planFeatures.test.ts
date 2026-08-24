import { describe, it, expect, vi } from "vitest";
import { planHasFeature, isPlanUpgradeRequired, applyFetchResults } from "./planFeatures";

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
    ["starter", "hide_branding", false],
    ["growth", "hide_branding", true],
    ["enterprise", "hide_branding", true],
    // free_ad(starterより下の最下段)はどのゲートも通らない
    ["free_ad", "avatar", false],
    ["free_ad", "voice_clone", false],
    ["free_ad", "analytics", false],
    ["free_ad", "conversion", false],
    ["free_ad", "deep_research", false],
    ["free_ad", "premium_avatar", false],
    ["free_ad", "sai_task", false],
    ["free_ad", "pre_dispatch", false],
    ["free_ad", "hide_branding", false],
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

// applyFetchResults: 会話分析・成約分析が共有する「成功だけ反映し、失敗を
// プラン制限とそれ以外に仕分ける」処理。以前は両ページに同じ実装が重複していた。
describe("applyFetchResults", () => {
  const res = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }) as Response;

  const rejectingRes = (status: number): Response =>
    ({
      ok: false,
      status,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    }) as unknown as Response;

  it("全て成功なら全ての apply が呼ばれ、失敗フラグは立たない", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const outcome = await applyFetchResults([
      { res: res(200, { v: 1 }), apply: a },
      { res: res(200, { v: 2 }), apply: b },
    ]);

    expect(a).toHaveBeenCalledWith({ v: 1 });
    expect(b).toHaveBeenCalledWith({ v: 2 });
    expect(outcome).toEqual({ planLimited: false, planLimitMessage: null, genericFailure: false });
  });

  it("403 plan_upgrade_required は genericFailure にせず、message を拾う", async () => {
    const outcome = await applyFetchResults([
      { res: res(403, { error: "plan_upgrade_required", message: "Growth以上です" }), apply: vi.fn() },
    ]);

    expect(outcome.planLimited).toBe(true);
    expect(outcome.planLimitMessage).toBe("Growth以上です");
    expect(outcome.genericFailure).toBe(false);
  });

  it("message の無い403でも planLimited は true になる(message有無で判定しない)", async () => {
    const outcome = await applyFetchResults([
      { res: res(403, { error: "plan_upgrade_required" }), apply: vi.fn() },
    ]);

    expect(outcome.planLimited).toBe(true);
    expect(outcome.planLimitMessage).toBeNull();
  });

  it("失敗した項目の apply は呼ばれない(古い値を上書きしない)", async () => {
    const ok = vi.fn();
    const ng = vi.fn();
    await applyFetchResults([
      { res: res(200, { v: 1 }), apply: ok },
      { res: res(500, { error: "internal_error" }), apply: ng },
    ]);

    expect(ok).toHaveBeenCalledTimes(1);
    expect(ng).not.toHaveBeenCalled();
  });

  it("エラーボディがJSONでない(502のHTML等)場合は genericFailure 扱いにする", async () => {
    const outcome = await applyFetchResults([{ res: rejectingRes(502), apply: vi.fn() }]);

    expect(outcome.genericFailure).toBe(true);
    expect(outcome.planLimited).toBe(false);
  });

  it("403と500が混在したら両方のフラグが立つ(表示側が復旧行動の要る方を優先できる)", async () => {
    const outcome = await applyFetchResults([
      { res: res(403, { error: "plan_upgrade_required", message: "Growth以上です" }), apply: vi.fn() },
      { res: res(500, { error: "internal_error" }), apply: vi.fn() },
    ]);

    expect(outcome.planLimited).toBe(true);
    expect(outcome.genericFailure).toBe(true);
  });

  it("複数本が403でも最初の message を代表として使う", async () => {
    const outcome = await applyFetchResults([
      { res: res(403, { error: "plan_upgrade_required", message: "1本目" }), apply: vi.fn() },
      { res: res(403, { error: "plan_upgrade_required", message: "2本目" }), apply: vi.fn() },
    ]);

    expect(outcome.planLimitMessage).toBe("1本目");
  });

  it("空配列でも例外にならない", async () => {
    const outcome = await applyFetchResults([]);
    expect(outcome).toEqual({ planLimited: false, planLimitMessage: null, genericFailure: false });
  });
});
