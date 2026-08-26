// src/api/admin/avatar/avatarCustomizeGate.test.ts
// avatar_customize ゲートの判定そのもの（HTTP を通さない単体）。
// ルート結線側は generationRoutes.test.ts / falGenerationRoutes.test.ts が検証する。

import { avatarCustomizeDenial, AVATAR_CUSTOMIZE_DENIAL } from "./avatarCustomizeGate";

const mockQuery = jest.fn();
const pool = { query: mockQuery };

beforeEach(() => {
  mockQuery.mockReset();
});

describe("avatarCustomizeDenial", () => {
  it.each([
    ["free_ad", true],
    ["starter", true],
    ["standard", true],
    ["growth", false],
    ["enterprise", false],
  ])("plan=%s のとき拒否=%s", async (plan, denied) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan }] });
    const result = await avatarCustomizeDenial(pool, false, "tenant-a");
    expect(result === null).toBe(!denied);
  });

  // ★Standard の商品性の芯★ アバターは使えるがカスタマイズはできない。
  it("standard は拒否され、案内文が「Growth以上」と「Standardでは既定アバターが使える」の両方を含む", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });
    const result = await avatarCustomizeDenial(pool, false, "tenant-a");
    expect(result).not.toBeNull();
    expect(result?.error).toBe("plan_upgrade_required");
    expect(result?.message).toContain("Growth");
    expect(result?.message).toContain("Standard");
  });

  it("super_admin はプラン照会そのものをせずにバイパスする(原価の出るサポート業務を止めない)", async () => {
    const result = await avatarCustomizeDenial(pool, true, "tenant-a");
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // fail-safe の向き: 機能ゲートなので「取得できなければ最も制限の強い段」= 拒否。
  it("DB障害時は拒否側に倒れる(プラン外機能を開かない)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    expect(await avatarCustomizeDenial(pool, false, "tenant-a")).toEqual(AVATAR_CUSTOMIZE_DENIAL);
  });

  it("plan列がnull / テナント不在 / 未知の文字列も拒否側に倒れる", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: null }] });
    expect(await avatarCustomizeDenial(pool, false, "tenant-a")).toEqual(AVATAR_CUSTOMIZE_DENIAL);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await avatarCustomizeDenial(pool, false, "tenant-a")).toEqual(AVATAR_CUSTOMIZE_DENIAL);

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "Growth" }] });
    expect(await avatarCustomizeDenial(pool, false, "tenant-a")).toEqual(AVATAR_CUSTOMIZE_DENIAL);
  });
});
