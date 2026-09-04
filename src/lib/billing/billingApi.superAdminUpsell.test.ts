// src/lib/billing/billingApi.superAdminUpsell.test.ts
//
// buildSuperAdminUpsellFigures — 運営向けアップセル文面に必要な数字の組み立て。
//
// ★このテストが守っているもの★
// - 超過量の計算が buildTenantUpsellFigures と同じ経路(computeExpectedBilling →
//   computeQuotaOverage)を通ること(第2の閾値表を作らない方針の実効性)
// - 粗利計算を自前で再実装せず fetchTenantEconomicsDetail に委譲していること
//   (集計SQLを2本目に書かない方針の実効性)
// - 売上/原価取得が失敗しても例外で落ちず、null 伝播で済むこと
import { buildSuperAdminUpsellFigures } from "./billingApi";
import { computeExpectedBilling } from "./stripeSync";
import { fetchTenantEconomicsDetail } from "./tenantEconomics";

jest.mock("./stripeSync", () => ({
  computeExpectedBilling: jest.fn(),
}));
jest.mock("./tenantEconomics", () => {
  const actual = jest.requireActual("./tenantEconomics");
  return { ...actual, fetchTenantEconomicsDetail: jest.fn() };
});

const mockComputeExpectedBilling = computeExpectedBilling as jest.Mock;
const mockFetchDetail = fetchTenantEconomicsDetail as jest.Mock;

function makeDb(name: string | null) {
  return { query: jest.fn().mockResolvedValue({ rows: [{ name }] }) };
}

const ORIGINAL_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  mockComputeExpectedBilling.mockReset();
  mockFetchDetail.mockReset();
  delete process.env.STRIPE_SECRET_KEY; // Stripe 到達不可の経路で決定的にテストする
});

afterAll(() => {
  if (ORIGINAL_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_KEY;
});

describe("buildSuperAdminUpsellFigures", () => {
  it("正常系: 粗利情報と超過量を __audience:'super_admin' の figures に組み立てる", async () => {
    mockComputeExpectedBilling.mockResolvedValue({ textUnits: 1500, avatarMinutes: 0 });
    mockFetchDetail.mockResolvedValue({
      row: {
        revenue_estimate_jpy: 22300, cost_base_jpy: 1500,
        gross_profit_jpy: 20800, gross_margin_pct: 93.3,
      },
    });

    const figures = await buildSuperAdminUpsellFigures(
      makeDb("Acme"), "acme", "text_overage", "standard", "growth", "202609",
    );

    expect(figures.__audience).toBe("super_admin");
    expect(figures.tenant_id).toBe("acme");
    expect(figures.tenant_name).toBe("Acme");
    expect(figures.revenue_estimate_jpy).toBe(22300);
    expect(figures.cost_base_jpy).toBe(1500);
    expect(figures.gross_profit_jpy).toBe(20800);
    expect(figures.gross_margin_pct).toBe(93.3);
    // standard の込み枠(1000)を1500が超えているので超過が出る
    expect(figures.text_overage).toBeGreaterThan(0);
  });

  it("★売上/原価が算出不可(detail が null)でも例外を投げず null 伝播する★", async () => {
    mockComputeExpectedBilling.mockResolvedValue({ textUnits: 100, avatarMinutes: 0 });
    mockFetchDetail.mockResolvedValue(null);

    const figures = await buildSuperAdminUpsellFigures(
      makeDb("Acme"), "acme", "text_overage", "standard", "growth", "202609",
    );
    expect(figures.revenue_estimate_jpy).toBeNull();
    expect(figures.gross_profit_jpy).toBeNull();
  });

  it("テナント名がDBに存在しない場合は null(tenant_idで代替表示するのは呼び出し側の責務)", async () => {
    mockComputeExpectedBilling.mockResolvedValue({ textUnits: 0, avatarMinutes: 0 });
    mockFetchDetail.mockResolvedValue(null);
    const figures = await buildSuperAdminUpsellFigures(
      { query: jest.fn().mockResolvedValue({ rows: [] }) },
      "ghost", "text_overage", "standard", "growth", "202609",
    );
    expect(figures.tenant_name).toBeNull();
  });

  it("computeExpectedBilling が例外を投げたら呼び出し元まで伝播する(呼び出し側の try/catch に委ねる設計)", async () => {
    mockComputeExpectedBilling.mockRejectedValue(new Error("db down"));
    mockFetchDetail.mockResolvedValue(null);
    await expect(
      buildSuperAdminUpsellFigures(makeDb("Acme"), "acme", "text_overage", "standard", "growth", "202609"),
    ).rejects.toThrow();
  });

  it("STRIPE_SECRET_KEY 未設定のとき current/recommended_base_monthly_jpy は null(0にしない)", async () => {
    mockComputeExpectedBilling.mockResolvedValue({ textUnits: 0, avatarMinutes: 0 });
    mockFetchDetail.mockResolvedValue(null);
    const figures = await buildSuperAdminUpsellFigures(
      makeDb("Acme"), "acme", "text_overage", "standard", "growth", "202609",
    );
    expect(figures.current_base_monthly_jpy).toBeNull();
    expect(figures.recommended_base_monthly_jpy).toBeNull();
  });

  it("超過が無ければ text_overage/avatar_overage_minutes は 0", async () => {
    mockComputeExpectedBilling.mockResolvedValue({ textUnits: 10, avatarMinutes: 0 });
    mockFetchDetail.mockResolvedValue(null);
    const figures = await buildSuperAdminUpsellFigures(
      makeDb("Acme"), "acme", "text_overage", "standard", "growth", "202609",
    );
    expect(figures.text_overage).toBe(0);
    expect(figures.avatar_overage_minutes).toBe(0);
  });
});
