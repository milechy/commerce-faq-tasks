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
  ] as const)("%s プランで %s = %s", (plan, feature, expected) => {
    expect(planHasFeature(plan, feature)).toBe(expected);
  });

  it("未知のplan文字列はstarter扱い(fail-safe)", () => {
    expect(planHasFeature("unknown-plan", "avatar")).toBe(false);
  });

  it("null/undefinedはstarter扱い", () => {
    expect(planHasFeature(null, "avatar")).toBe(false);
    expect(planHasFeature(undefined, "avatar")).toBe(false);
  });
});

describe("getTenantPlan", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("DBのplan列をそのまま返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    expect(await getTenantPlan("tenant-a")).toBe("growth");
  });

  it("plan列がnull/不正値ならstarterにフォールバック", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: null }] });
    expect(await getTenantPlan("tenant-a")).toBe("starter");

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "typo-plan" }] });
    expect(await getTenantPlan("tenant-a")).toBe("starter");
  });

  it("テナントが存在しない場合もstarterにフォールバック", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getTenantPlan("nonexistent")).toBe("starter");
  });

  it("DB障害時はfail-safeでstarter扱い", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    expect(await getTenantPlan("tenant-a")).toBe("starter");
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
