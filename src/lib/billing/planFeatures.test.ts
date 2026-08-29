// src/lib/billing/planFeatures.test.ts
// LP料金表(Starter/Growth/Enterprise)に対応するプラン別機能制限のテスト

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  planHasFeature,
  getTenantPlan,
  tenantHasFeature,
  tenantPlanCache,
  queryTenantPlanResult,
  resolveShareForPlan,
  resolveShareForTenantPlan,
  planShowsAdPromo,
} from "./planFeatures";
import type { GatedFeature } from "./planFeatures";

// ゲート一覧を各テストで書き写すと、新しいゲートを足したときに片方だけ更新されて
// 「新ゲートだけ fail-safe が検証されていない」状態になる。1箇所に置く。
const ALL_GATED_FEATURES: readonly GatedFeature[] = [
  "avatar",
  "avatar_customize",
  "voice_clone",
  "analytics",
  "conversion",
  "deep_research",
  "premium_avatar",
  "sai_task",
  "pre_dispatch",
  "hide_branding",
];

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
    // standard(starterとgrowthの間)。開くのは avatar と analytics(会話分析)で、
    // 他は全て growth 以上のまま。★ここが Standard(¥9,800)の商品性そのもの★
    ["starter", "avatar", false],
    ["standard", "avatar", true],
    ["standard", "avatar_customize", false],
    ["standard", "premium_avatar", false],
    ["standard", "analytics", true],
    ["standard", "conversion", false],
    ["standard", "hide_branding", false],
    ["standard", "voice_clone", false],
    ["standard", "deep_research", false],
    ["standard", "sai_task", false],
    ["standard", "pre_dispatch", false],
    // avatar_customize(自社アバターの作成)は Growth 以上。
    ["free_ad", "avatar_customize", false],
    ["starter", "avatar_customize", false],
    ["growth", "avatar_customize", true],
    ["enterprise", "avatar_customize", true],
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
    for (const feature of ALL_GATED_FEATURES) {
      expect(planHasFeature("unknown-plan", feature)).toBe(planHasFeature("free_ad", feature));
    }
  });

  it("null/undefinedはfree_ad扱い — free_adと同じ判定結果になる", () => {
    for (const feature of ALL_GATED_FEATURES) {
      expect(planHasFeature(null, feature)).toBe(planHasFeature("free_ad", feature));
      expect(planHasFeature(undefined, feature)).toBe(planHasFeature("free_ad", feature));
    }
  });
});

// CLAUDE.md 禁止55「段の間に挿入する場合は、既存プランの PLAN_RANK の相対順序が
// 崩れていないかを必ず確認する」。PLAN_RANK は非公開なので、順序そのものではなく
// 「順序から導かれる観測可能な性質」で固定する。standard に growth と同じ序数を
// 与えるような取り違えは、この describe が検出する（個別ゲートの表だけでは、
// standard の行を足した本人が同じ勘違いのまま期待値も書いてしまい検出できない）。
describe("PLAN_RANK の相対順序（standard を starter と growth の間に挿入した回帰）", () => {
  // 上位プランは下位プランの機能を必ず包含する = ランクが単調増加している証明。
  it("free_ad ⊂ starter ⊂ standard ⊂ growth ⊂ enterprise で機能集合が単調に増える", () => {
    const ORDER = ["free_ad", "starter", "standard", "growth", "enterprise"] as const;
    const featuresOf = (plan: string) => ALL_GATED_FEATURES.filter((f) => planHasFeature(plan, f));

    for (let i = 0; i < ORDER.length - 1; i++) {
      const lower = featuresOf(ORDER[i]);
      const higher = featuresOf(ORDER[i + 1]);
      for (const f of lower) {
        expect(higher).toContain(f);
      }
    }
  });

  it("standard は starter より真に多く、growth より真に少ない機能を持つ(同格に潰れていない)", () => {
    const count = (plan: string) => ALL_GATED_FEATURES.filter((f) => planHasFeature(plan, f)).length;
    expect(count("starter")).toBeLessThan(count("standard"));
    expect(count("standard")).toBeLessThan(count("growth"));
  });

  it("standard で開くのは avatar と analytics(値引きではなくアバター開放・会話分析が目的)", () => {
    const gained = ALL_GATED_FEATURES.filter(
      (f) => planHasFeature("standard", f) && !planHasFeature("starter", f),
    );
    expect(gained).toEqual(["avatar", "analytics"]);
  });

  it("growth で追加されるものに avatar_customize が含まれる(Standardとの差別化の実体)", () => {
    const gained = ALL_GATED_FEATURES.filter(
      (f) => planHasFeature("growth", f) && !planHasFeature("standard", f),
    );
    expect(gained).toContain("avatar_customize");
  });
});

describe("getTenantPlan", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // TTLキャッシュが前のテストの値を持ち越さないように毎回クリアする
    // (下の「TTLキャッシュ」describeでは意図的にクリアしないテストがある)。
    tenantPlanCache.clear();
  });

  it("DBのplan列をそのまま返す(5値とも)", async () => {
    // 同一tenantIdでの連続呼び出しはTTLキャッシュに乗るため、
    // DBの値をそのまま返す挙動そのものを検証するには都度クリアする
    // (キャッシュそのものの挙動は下の「TTLキャッシュ」describeで検証する)。
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "free_ad" }] });
    expect(await getTenantPlan("tenant-a")).toBe("free_ad");
    tenantPlanCache.clear();

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    expect(await getTenantPlan("tenant-a")).toBe("starter");
    tenantPlanCache.clear();

    // ★queryTenantPlan の allowlist に standard が無いと、standard テナントが
    // 恒久的に free_ad へ落ちて契約済みの機能が全て閉じる(DB障害時ではなく常時)。★
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });
    expect(await getTenantPlan("tenant-a")).toBe("standard");
    tenantPlanCache.clear();

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] });
    expect(await getTenantPlan("tenant-a")).toBe("growth");
    tenantPlanCache.clear();

    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "enterprise" }] });
    expect(await getTenantPlan("tenant-a")).toBe("enterprise");
  });

  // allowlist 落ちは「free_ad へ倒れる」という fail-safe と見分けがつかないため、
  // 文字列一致だけでなく「アバターが使えること」まで見て実害の有無で固定する。
  it("standard テナントは avatar が開き avatar_customize は閉じたままになる", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });
    const plan = await getTenantPlan("tenant-standard");
    expect(planHasFeature(plan, "avatar")).toBe(true);
    expect(planHasFeature(plan, "avatar_customize")).toBe(false);
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
    tenantPlanCache.clear();

    // standard を allowlist に足したことで大文字・前後空白まで通るようになっていないこと。
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "Standard" }] });
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

// ---------------------------------------------------------------------------
// S4(共有学習プールの参加モデル): queryTenantPlanResult / resolveShareForPlan
//
// ★このタスク最大の罠のテスト★
// queryTenantPlan の fail-safe(未知/null/DB障害 → free_ad)に share の強制ロジックが
// 相乗りすると、DB障害の瞬間に全テナントが強制データ共有になる。
// queryTenantPlanResult は queryTenantPlan とは独立に「確実に判明したか」を
// null で区別して返し、resolveShareForPlan は null(判定不能)を free_ad として
// 扱わないことを固定する。
// ---------------------------------------------------------------------------

describe("queryTenantPlanResult", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  // ★queryTenantPlan とは別関数・別の allowlist なので、プラン段を足すと
  // 片方だけ直して片方を取り残す事故が起きる。ここで standard を含めて固定する。
  // 取り残すと、standard テナントの請求倍率が「未確定(null)」に落ちる
  // (usageTracker が queryTenantPlanResult を使うため。.claude/rules/billing.md §4)。
  it("既知の5値はそのまま返す(standard を含む)", async () => {
    for (const plan of ["free_ad", "starter", "standard", "growth", "enterprise"] as const) {
      mockQuery.mockResolvedValueOnce({ rows: [{ plan }] });
      expect(await queryTenantPlanResult({ query: mockQuery }, "tenant-a")).toBe(plan);
    }
  });

  it("未知の文字列は standard を足した後も null のまま(allowlist が緩んでいない)", async () => {
    for (const plan of ["Standard", "standard ", "std", "premium"]) {
      mockQuery.mockResolvedValueOnce({ rows: [{ plan }] });
      expect(await queryTenantPlanResult({ query: mockQuery }, "tenant-a")).toBeNull();
    }
  });

  it("plan列がnullの場合は null(未確定。free_adに確定させない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: null }] });
    expect(await queryTenantPlanResult({ query: mockQuery }, "tenant-a")).toBeNull();
  });

  it("未知のplan文字列の場合は null(未確定。free_adに確定させない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "typo-plan" }] });
    expect(await queryTenantPlanResult({ query: mockQuery }, "tenant-a")).toBeNull();
  });

  it("テナントが存在しない場合(rowsが空)は null", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await queryTenantPlanResult({ query: mockQuery }, "nonexistent")).toBeNull();
  });

  it("★DB障害(reject)時は null(free_adに確定させない。queryTenantPlanと違いfree_adへ倒さない)★", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    expect(await queryTenantPlanResult({ query: mockQuery }, "tenant-a")).toBeNull();
  });
});

describe("resolveShareForPlan", () => {
  it("free_ad確定 → 強制ON({forced:true, value:true})", () => {
    expect(resolveShareForPlan("free_ad")).toEqual({ forced: true, value: true });
  });

  it.each(["starter", "growth", "enterprise"] as const)(
    "%s → 強制なし・既定OFF({forced:false, default:false})",
    (plan) => {
      expect(resolveShareForPlan(plan)).toEqual({ forced: false, default: false });
    },
  );

  it("★判定不能(null)の場合は強制しない。free_ad扱いで強制ONにしない★", () => {
    expect(resolveShareForPlan(null)).toEqual({ forced: false, default: false });
    // free_ad確定の場合(forced:true)とは明確に異なる結果であることを対比で固定する。
    expect(resolveShareForPlan(null)).not.toEqual(resolveShareForPlan("free_ad"));
  });
});

describe("resolveShareForTenantPlan(queryTenantPlanResult + resolveShareForPlanの結合)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("free_ad確定テナント → 強制ON", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "free_ad" }] });
    expect(await resolveShareForTenantPlan({ query: mockQuery }, "tenant-a")).toEqual({
      forced: true,
      value: true,
    });
  });

  it.each(["starter", "growth", "enterprise"] as const)(
    "%sテナント → 強制なし・既定OFF",
    async (plan) => {
      mockQuery.mockResolvedValueOnce({ rows: [{ plan }] });
      expect(await resolveShareForTenantPlan({ query: mockQuery }, "tenant-a")).toEqual({
        forced: false,
        default: false,
      });
    },
  );

  it("★DB障害時 → 強制を適用せず share=OFF相当({forced:false})。free_ad扱いで強制ONにしない★", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    expect(await resolveShareForTenantPlan({ query: mockQuery }, "tenant-a")).toEqual({
      forced: false,
      default: false,
    });
  });

  it("★plan列がnull → 同上(強制ONにしない)★", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: null }] });
    expect(await resolveShareForTenantPlan({ query: mockQuery }, "tenant-a")).toEqual({
      forced: false,
      default: false,
    });
  });

  it("★プランが未知の文字列 → 同上(強制ONにしない)★", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "typo-plan" }] });
    expect(await resolveShareForTenantPlan({ query: mockQuery }, "tenant-a")).toEqual({
      forced: false,
      default: false,
    });
  });
});

// AD-2: free_ad プラン限定でR2C自身の広告帯を掲出するかどうかの判定。
// fail-safe の向きが planHasFeature/hide_branding とは逆(未知/nullはfalse=掲出しない)であることを
// 明示的に固定する(有料テナントのサイトに誤って広告が出る事故を避けるため)。
describe("planShowsAdPromo", () => {
  it("free_ad のみ true", () => {
    expect(planShowsAdPromo("free_ad")).toBe(true);
  });

  it.each(["starter", "standard", "growth", "enterprise"] as const)(
    "%s は false",
    (plan) => {
      expect(planShowsAdPromo(plan)).toBe(false);
    },
  );

  it("null は false(fail-safe: 判定不能時は掲出しない)", () => {
    expect(planShowsAdPromo(null)).toBe(false);
  });

  it("undefined は false(fail-safe: 判定不能時は掲出しない)", () => {
    expect(planShowsAdPromo(undefined)).toBe(false);
  });

  it("未知の文字列は false(fail-safe: free_ad へ『昇格』させない)", () => {
    expect(planShowsAdPromo("gold")).toBe(false);
  });

  it("空文字は false", () => {
    expect(planShowsAdPromo("")).toBe(false);
  });
});
