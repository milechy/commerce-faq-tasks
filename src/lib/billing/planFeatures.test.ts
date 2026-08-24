// src/lib/billing/planFeatures.test.ts
// LP料金表(Starter/Growth/Enterprise)に対応するプラン別機能制限のテスト

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { planHasFeature, getTenantPlan, tenantHasFeature, tenantPlanCache } from "./planFeatures";

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
    // TTLキャッシュが前のテストの値を持ち越さないように毎回クリアする
    // (下の「TTLキャッシュ」describeでは意図的にクリアしないテストがある)。
    tenantPlanCache.clear();
  });

  it("DBのplan列をそのまま返す(4値とも)", async () => {
    // 同一tenantIdでの連続呼び出しはTTLキャッシュに乗るため、
    // DBの値をそのまま返す挙動そのものを検証するには都度クリアする
    // (キャッシュそのものの挙動は下の「TTLキャッシュ」describeで検証する)。
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "free_ad" }] });
    expect(await getTenantPlan("tenant-a")).toBe("free_ad");
    tenantPlanCache.clear();

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    expect(await getTenantPlan("tenant-a")).toBe("starter");
    tenantPlanCache.clear();

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    expect(await getTenantPlan("tenant-a")).toBe("growth");
    tenantPlanCache.clear();

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
    tenantPlanCache.clear();

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
    tenantPlanCache.clear();
  });

  it("plan取得結果に基づき機能可否を判定する", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "enterprise" }] });
    expect(await tenantHasFeature("tenant-a", "voice_clone")).toBe(true);
    tenantPlanCache.clear();

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    expect(await tenantHasFeature("tenant-a", "voice_clone")).toBe(false);
  });
});

// P2c: getTenantPlan()のTTLキャッシュ。
// /api/chat が全リクエストで無条件に呼ぶ関数のため、DBラウンドトリップを
// 60秒キャッシュで間引く(queryTenantPlan自体・fail-safe挙動は変更しない)。
describe("getTenantPlan TTLキャッシュ", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    tenantPlanCache.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("同一tenantIdへの連続呼び出しはDBクエリが1回しか発行されない", async () => {
    mockQuery.mockResolvedValue({ rows: [{ plan: "growth" }] });

    expect(await getTenantPlan("tenant-cache")).toBe("growth");
    expect(await getTenantPlan("tenant-cache")).toBe("growth");
    expect(await getTenantPlan("tenant-cache")).toBe("growth");

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("TTL(60秒)経過後は再度DBに問い合わせる", async () => {
    mockQuery.mockResolvedValue({ rows: [{ plan: "starter" }] });

    expect(await getTenantPlan("tenant-cache")).toBe("starter");
    expect(mockQuery).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60 * 1000 + 1);

    expect(await getTenantPlan("tenant-cache")).toBe("starter");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  // 既知のトレードオフ: プラン変更(管理操作)はTTL内は反映されず古い値を返し得る。
  // プラン変更は即時反映が必須の操作ではなく、動的ウィジェットルート自体が
  // 既に24hキャッシュを許容している設計と整合するため許容する。
  it("TTL内はプランが変わったテナントでも古い値を返し得る(既知のトレードオフ)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    expect(await getTenantPlan("tenant-cache")).toBe("starter");

    // DB側では既にgrowthへ変更済みだが、TTL内はキャッシュのstarterを返す。
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    expect(await getTenantPlan("tenant-cache")).toBe("starter");
    expect(mockQuery).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60 * 1000 + 1);

    expect(await getTenantPlan("tenant-cache")).toBe("growth");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("異なるtenantIdはそれぞれ独立してキャッシュされる", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    expect(await getTenantPlan("tenant-x")).toBe("starter");

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "enterprise" }] });
    expect(await getTenantPlan("tenant-y")).toBe("enterprise");

    expect(await getTenantPlan("tenant-x")).toBe("starter");
    expect(await getTenantPlan("tenant-y")).toBe("enterprise");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
