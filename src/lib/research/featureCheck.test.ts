// src/lib/research/featureCheck.test.ts
// GID 1216944249525907: deep_research は features フラグ ON に加えて
// プランが Enterprise 以上であることも要求する（原価が跳ねるため）。

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { isDeepResearchEnabled } from "./featureCheck";

describe("isDeepResearchEnabled", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("tenantId が空なら false", async () => {
    expect(await isDeepResearchEnabled("")).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("フラグOFFならプランに関係なくfalse", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ features: { deep_research: false }, plan: "enterprise" }],
    });
    expect(await isDeepResearchEnabled("tenant-a")).toBe(false);
  });

  it("フラグONでもstarterプランならfalse", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ features: { deep_research: true }, plan: "starter" }],
    });
    expect(await isDeepResearchEnabled("tenant-a")).toBe(false);
  });

  it("フラグONでもgrowthプランならfalse（Enterprise専用）", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ features: { deep_research: true }, plan: "growth" }],
    });
    expect(await isDeepResearchEnabled("tenant-a")).toBe(false);
  });

  it("フラグONかつenterpriseプランならtrue", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ features: { deep_research: true }, plan: "enterprise" }],
    });
    expect(await isDeepResearchEnabled("tenant-a")).toBe(true);
  });

  it("plan未設定(null)はfail-safeでstarter扱いとなりfalse", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ features: { deep_research: true }, plan: null }],
    });
    expect(await isDeepResearchEnabled("tenant-a")).toBe(false);
  });

  it("テナント不在なら false", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await isDeepResearchEnabled("nonexistent")).toBe(false);
  });

  it("features未設定なら false", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ features: null, plan: "enterprise" }] });
    expect(await isDeepResearchEnabled("tenant-a")).toBe(false);
  });

  it("DB障害時はfail-safeでfalse", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    expect(await isDeepResearchEnabled("tenant-a")).toBe(false);
  });
});
