// src/lib/billing/billingApi.superAdminUpsell.test.ts
//
// buildSuperAdminUpsellFigures — 運営向けアップセル文面に必要な数字の組み立て。
//
// ★このテストが守っているもの★
// - 超過量(text_overage/avatar_overage_minutes)・粗利(revenue/cost/profit/margin)・
//   テナント名のすべてが fetchTenantEconomicsDetail の返り値(1回分)から組み立てられ、
//   独自の computeExpectedBilling 呼び出しや独自の name クエリを持たないこと
//   (P0: 同じ集計を2回実行しない。実DBでの再現は billingSqlIntegration.test.ts)
// - fetchTenantEconomicsDetail が null / 例外を返しても、null 伝播 or 伝播で
//   落ちること(黙って握りつぶさない)
import { buildSuperAdminUpsellFigures } from "./billingApi";
import { fetchTenantEconomicsDetail } from "./tenantEconomics";

jest.mock("./tenantEconomics", () => {
  const actual = jest.requireActual("./tenantEconomics");
  return { ...actual, fetchTenantEconomicsDetail: jest.fn() };
});

const mockFetchDetail = fetchTenantEconomicsDetail as jest.Mock;

const ORIGINAL_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  mockFetchDetail.mockReset();
  delete process.env.STRIPE_SECRET_KEY; // Stripe 到達不可の経路で決定的にテストする
});

afterAll(() => {
  if (ORIGINAL_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_KEY;
});

const STUB_DB = { query: jest.fn() };

describe("buildSuperAdminUpsellFigures", () => {
  it("正常系: fetchTenantEconomicsDetail の1回分の row から粗利情報と超過量を組み立てる", async () => {
    mockFetchDetail.mockResolvedValue({
      row: {
        tenant_name: "Acme", text_units: 1500, avatar_minutes: 0,
        revenue_estimate_jpy: 22300, cost_base_jpy: 1500,
        gross_profit_jpy: 20800, gross_margin_pct: 93.3,
      },
    });

    const figures = await buildSuperAdminUpsellFigures(
      STUB_DB, "acme", "text_overage", "standard", "growth", "202609",
    );

    expect(figures.__audience).toBe("super_admin");
    expect(figures.tenant_id).toBe("acme");
    expect(figures.tenant_name).toBe("Acme");
    expect(figures.revenue_estimate_jpy).toBe(22300);
    expect(figures.cost_base_jpy).toBe(1500);
    expect(figures.gross_profit_jpy).toBe(20800);
    expect(figures.gross_margin_pct).toBe(93.3);
    // standard の込み枠(1000)を1500が超えているので超過が出る
    expect(figures.text_overage).toBe(500);
    // fetchTenantEconomicsDetail は1回しか呼ばれない(P0: 2重実行の再発防止)
    expect(mockFetchDetail).toHaveBeenCalledTimes(1);
  });

  it("★プラン不一致でも超過量は evidence の currentPlan の込み枠を基準に計算する★", async () => {
    // evidence(呼び出し引数)は standard のまま、テナントは実際には growth へ
    // 自己アップグレード済み、という状況を想定。fetchTenantEconomicsDetail が
    // 返す text_units はテナントの「実プラン」で1回だけ計算された値だが、
    // その値自体はプランに依存しない生の数量(stripeSync.ts 参照)なので、
    // currentPlan(standard)の込み枠と比べてよい。
    mockFetchDetail.mockResolvedValue({
      row: { tenant_name: "Acme", text_units: 1200, avatar_minutes: 0 },
    });
    const figures = await buildSuperAdminUpsellFigures(
      STUB_DB, "acme", "text_overage", "standard", "growth", "202609",
    );
    // standard(込み枠1000) 基準: 200超過。growth(込み枠3000)基準なら0になり検出できる。
    expect(figures.text_overage).toBe(200);
  });

  it("★売上/原価が算出不可(detail が null)でも例外を投げず null 伝播する★", async () => {
    mockFetchDetail.mockResolvedValue(null);

    const figures = await buildSuperAdminUpsellFigures(
      STUB_DB, "acme", "text_overage", "standard", "growth", "202609",
    );
    expect(figures.revenue_estimate_jpy).toBeNull();
    expect(figures.gross_profit_jpy).toBeNull();
    expect(figures.tenant_name).toBeNull();
    // row が無いので超過量は0扱い(未算出を負の超過として誤魔化さない)
    expect(figures.text_overage).toBe(0);
    expect(figures.avatar_overage_minutes).toBe(0);
  });

  it("fetchTenantEconomicsDetail が例外を投げたら呼び出し元まで伝播する(呼び出し側の try/catch に委ねる設計)", async () => {
    mockFetchDetail.mockRejectedValue(new Error("db down"));
    await expect(
      buildSuperAdminUpsellFigures(STUB_DB, "acme", "text_overage", "standard", "growth", "202609"),
    ).rejects.toThrow("db down");
  });

  it("STRIPE_SECRET_KEY 未設定のとき current/recommended_base_monthly_jpy は null(0にしない)", async () => {
    mockFetchDetail.mockResolvedValue(null);
    const figures = await buildSuperAdminUpsellFigures(
      STUB_DB, "acme", "text_overage", "standard", "growth", "202609",
    );
    expect(figures.current_base_monthly_jpy).toBeNull();
    expect(figures.recommended_base_monthly_jpy).toBeNull();
  });

  it("超過が無ければ text_overage/avatar_overage_minutes は 0", async () => {
    mockFetchDetail.mockResolvedValue({
      row: { tenant_name: "Acme", text_units: 10, avatar_minutes: 0 },
    });
    const figures = await buildSuperAdminUpsellFigures(
      STUB_DB, "acme", "text_overage", "standard", "growth", "202609",
    );
    expect(figures.text_overage).toBe(0);
    expect(figures.avatar_overage_minutes).toBe(0);
  });

  it("込み枠を持たないプラン(starter)は超過0のまま、負値や例外にならない", async () => {
    mockFetchDetail.mockResolvedValue({
      row: { tenant_name: "Acme", text_units: 999999, avatar_minutes: 999999 },
    });
    const figures = await buildSuperAdminUpsellFigures(
      STUB_DB, "acme", "text_overage", "starter", "growth", "202609",
    );
    expect(figures.text_overage).toBe(0);
    expect(figures.avatar_overage_minutes).toBe(0);
  });
});
