// src/lib/billing/planFeatures.test.ts
// LP料金表(Starter/Growth/Enterprise)に対応するプラン別機能制限のテスト

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { planHasFeature, getTenantPlan, tenantHasFeature } from "./planFeatures";

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

  // (a) fail-safe 3箇所のうち1つ目(rank()内部)の回帰検知。
  // 現在定義されている全ゲートは growth 以上を要求するため、rank が 0(旧starter)でも
  // -1(新free_ad)でも planHasFeature の戻り値自体は変わらない(両方false)。
  // そのため「booleanが変わらないこと」ではなく、「未知/null/undefinedがfree_adと
  // 同じ判定結果になること」で新しい最下段への変化を捉える。文字列としての
  // 落とし先そのものは getTenantPlan/queryTenantPlan のテスト((b)(c))で直接検証する。
  it("未知のplan文字列はfree_ad扱い(fail-safe) — free_adと同じ判定結果になる", () => {
    for (const feature of [
      "avatar", "voice_clone", "analytics", "conversion",
      "deep_research", "premium_avatar", "sai_task", "pre_dispatch", "hide_branding",
    ] as const) {
      expect(planHasFeature("unknown-plan", feature)).toBe(planHasFeature("free_ad", feature));
    }
  });

  it("null/undefinedはfree_ad扱い — free_adと同じ判定結果になる", () => {
    for (const feature of [
      "avatar", "voice_clone", "analytics", "conversion",
      "deep_research", "premium_avatar", "sai_task", "pre_dispatch", "hide_branding",
    ] as const) {
      expect(planHasFeature(null, feature)).toBe(planHasFeature("free_ad", feature));
      expect(planHasFeature(undefined, feature)).toBe(planHasFeature("free_ad", feature));
    }
  });
});

describe("getTenantPlan", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("DBのplan列をそのまま返す(4値とも)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "free_ad" }] });
    expect(await getTenantPlan("tenant-a")).toBe("free_ad");

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    expect(await getTenantPlan("tenant-a")).toBe("starter");

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    expect(await getTenantPlan("tenant-a")).toBe("growth");

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "enterprise" }] });
    expect(await getTenantPlan("tenant-a")).toBe("enterprise");
  });

  // (b) fail-safe 3箇所のうち2つ目(queryTenantPlanのallowlist)の回帰検知。
  // starterではなくfree_adへ落ちることを直接文字列で検証する
  // (CLAUDE.md 絶対にやってはいけないこと37: 落とし先を1箇所でも取り残すと
  // DB障害時に無料テナントがstarterへ「昇格」する)。
  it("plan列がnull/不正値ならfree_adにフォールバック(starterへ「昇格」しない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: null }] });
    expect(await getTenantPlan("tenant-a")).toBe("free_ad");

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "typo-plan" }] });
    expect(await getTenantPlan("tenant-a")).toBe("free_ad");
  });

  it("テナントが存在しない場合もfree_adにフォールバック", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getTenantPlan("nonexistent")).toBe("free_ad");
  });

  // (c) fail-safe 3箇所のうち3つ目(queryTenantPlanのcatch返り値)の回帰検知。
  it("DB障害時はfail-safeでfree_ad扱い(starterへ「昇格」しない)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    expect(await getTenantPlan("tenant-a")).toBe("free_ad");
  });
});

describe("tenantHasFeature", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("plan取得結果に基づき機能可否を判定する", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "enterprise" }] });
    expect(await tenantHasFeature("tenant-a", "voice_clone")).toBe(true);

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    expect(await tenantHasFeature("tenant-a", "voice_clone")).toBe(false);
  });
});
