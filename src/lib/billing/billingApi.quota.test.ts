// src/lib/billing/billingApi.quota.test.ts
// fetchBillingQuota / GET /v1/admin/billing/quota — 込み枠・無料枠の残量可視化(UX-C)。
//
// ★このテストが守っている事故★
// #1015 で Standard/Growth に込み枠(基本料に含まれる利用量)を導入したが、
// 消費量・残量を出す画面が admin-ui に1つも無かった(横断grepでゼロ件)。
// 上限を設けない従量課金方針のもとでは、「気づいたら大幅超過」を防ぐ唯一の
// 手段がこの表示。数字を間違えると「まだ余裕がある」と誤認させて超過に
// 気づかせないか、逆に「もう枠が無い」と誤解させて過剰にプランを上げさせる。

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import pino from "pino";
import { registerBillingAdminRoutes, fetchBillingQuota } from "./billingApi";
import { computeExpectedBilling } from "./stripeSync";

jest.mock("./stripeSync", () => ({
  computeExpectedBilling: jest.fn(),
}));

const mockComputeExpectedBilling = computeExpectedBilling as jest.Mock;

function billingResult(overrides: Partial<{ textUnits: number; avatarMinutes: number }> = {}) {
  return {
    totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0,
    billedQuantity: 0, fallbackMultiplier: 1,
    textUnits: 0, avatarMinutes: 0,
    ...overrides,
  };
}

function makeDb(plan: string | null | undefined) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("SELECT plan FROM tenants")) {
        return plan === undefined ? { rows: [] } : { rows: [{ plan }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

const silentLogger = pino({ level: "silent" });

beforeEach(() => {
  jest.clearAllMocks();
  mockComputeExpectedBilling.mockResolvedValue(billingResult());
});

describe("fetchBillingQuota", () => {
  it("テナントが存在しなければ null", async () => {
    const result = await fetchBillingQuota(makeDb(undefined), "tenant-a");
    expect(result).toBeNull();
  });

  it("free_ad: text/avatarの込み枠はnull、freeAdに使用数・上限・残数を返す", async () => {
    mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 150 }));
    const result = await fetchBillingQuota(makeDb("free_ad"), "tenant-a");

    expect(result?.text).toEqual({ used: 150, included: null, overage: 0 });
    expect(result?.avatar).toEqual({ usedMinutes: 0, includedMinutes: null, overageMinutes: 0 });
    expect(result?.freeAd).toEqual({ used: 150, limit: 200, remaining: 50 });
  });

  // ★上限到達後もマイナスの残数を出さない★ 「あと-5会話」のような表示は
  // 直感に反するテナント向けUI事故になる。
  it("free_ad: 上限超過時は remaining が0で止まる(負数にならない)", async () => {
    mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 250 }));
    const result = await fetchBillingQuota(makeDb("free_ad"), "tenant-a");

    expect(result?.freeAd).toEqual({ used: 250, limit: 200, remaining: 0 });
  });

  it("starter: 込み枠という概念自体が無い(included=null, overage=0, freeAd=null)", async () => {
    mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 500 }));
    const result = await fetchBillingQuota(makeDb("starter"), "tenant-a");

    expect(result?.text).toEqual({ used: 500, included: null, overage: 0 });
    expect(result?.freeAd).toBeNull();
  });

  it("enterprise: 込み枠という概念が無い(無制限。starterと同じnullだがUI側はplanで判別する)", async () => {
    mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 99999 }));
    const result = await fetchBillingQuota(makeDb("enterprise"), "tenant-a");

    expect(result?.text).toEqual({ used: 99999, included: null, overage: 0 });
    expect(result?.plan).toBe("enterprise");
  });

  describe("standard(込み枠1,000会話/30分)", () => {
    it("込み枠内なら overage=0", async () => {
      mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 800, avatarMinutes: 20 }));
      const result = await fetchBillingQuota(makeDb("standard"), "tenant-a");

      expect(result?.text).toEqual({ used: 800, included: 1000, overage: 0 });
      expect(result?.avatar).toEqual({ usedMinutes: 20, includedMinutes: 30, overageMinutes: 0 });
      expect(result?.freeAd).toBeNull();
    });

    it("込み枠ちょうどなら overage=0(境界)", async () => {
      mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 1000, avatarMinutes: 30 }));
      const result = await fetchBillingQuota(makeDb("standard"), "tenant-a");

      expect(result?.text.overage).toBe(0);
      expect(result?.avatar.overageMinutes).toBe(0);
    });

    it("両次元とも超過した分だけ overage に出る", async () => {
      mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 1250, avatarMinutes: 45 }));
      const result = await fetchBillingQuota(makeDb("standard"), "tenant-a");

      expect(result?.text).toEqual({ used: 1250, included: 1000, overage: 250 });
      expect(result?.avatar).toEqual({ usedMinutes: 45, includedMinutes: 30, overageMinutes: 15 });
    });

    // ★テキストとアバターは別枠(合算しない)★ 片方の余りがもう片方の超過を
    // 相殺して見えると、実際は大幅超過なのに「まだ余裕がある」と誤認させる。
    it("テキストに余裕があってもアバター超過は独立して出る(別枠であることの確認)", async () => {
      mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 100, avatarMinutes: 60 }));
      const result = await fetchBillingQuota(makeDb("standard"), "tenant-a");

      expect(result?.text.overage).toBe(0);
      expect(result?.avatar.overageMinutes).toBe(30); // 60-30、テキストの余り(900)に一切影響されない
    });
  });

  it("growth: 込み枠(3,000会話/150分)がstandardと別の数値で適用される", async () => {
    mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 3100, avatarMinutes: 160 }));
    const result = await fetchBillingQuota(makeDb("growth"), "tenant-a");

    expect(result?.text).toEqual({ used: 3100, included: 3000, overage: 100 });
    expect(result?.avatar).toEqual({ usedMinutes: 160, includedMinutes: 150, overageMinutes: 10 });
  });

  it("プランがnull(未確定)でも例外を投げず、込み枠なし扱いで返す", async () => {
    mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 5 }));
    const result = await fetchBillingQuota(makeDb(null), "tenant-a");

    expect(result?.plan).toBeNull();
    expect(result?.text.included).toBeNull();
    expect(result?.freeAd).toBeNull(); // null は free_ad と一致しない(文字列一致のみ)
  });

  it("computeExpectedBillingへ渡す期間はJST暦月の境界(getMonthRangeJstと整合)", async () => {
    const db = makeDb("standard");
    await fetchBillingQuota(db, "tenant-a");

    const [, , from, to] = mockComputeExpectedBilling.mock.calls[0];
    // 呼び出し時点のJST暦月の開始・終了が渡っていること(半開区間: from < to)
    expect(new Date(to).getTime()).toBeGreaterThan(new Date(from).getTime());
  });
});

describe("GET /v1/admin/billing/quota", () => {
  type Role = "super_admin" | "client_admin";
  function makeApp(db: any, role: Role, tenantId = "tenant-a") {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.supabaseUser = { email: "admin@example.com", app_metadata: { tenant_id: tenantId, role } };
      next();
    });
    registerBillingAdminRoutes(app, db, silentLogger, []);
    return app;
  }

  it("client_admin は自テナントの込み枠を取得できる", async () => {
    mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 500 }));
    const res = await request(makeApp(makeDb("standard"), "client_admin"))
      .get("/v1/admin/billing/quota")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe("tenant-a");
    expect(res.body.text.used).toBe(500);
  });

  it("super_admin は tenantId クエリ必須(未指定なら400)", async () => {
    const res = await request(makeApp(makeDb("standard"), "super_admin"))
      .get("/v1/admin/billing/quota")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tenantId_required");
  });

  it("super_admin は tenantId クエリ指定で任意テナントの込み枠を取得できる", async () => {
    mockComputeExpectedBilling.mockResolvedValue(billingResult({ textUnits: 42 }));
    const res = await request(makeApp(makeDb("growth"), "super_admin"))
      .get("/v1/admin/billing/quota?tenantId=tenant-b")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe("tenant-b");
  });

  it("存在しないテナントは404", async () => {
    const res = await request(makeApp(makeDb(undefined), "client_admin"))
      .get("/v1/admin/billing/quota")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(404);
  });

  it("集計中に例外が起きたら500(黙って0件を返さない)", async () => {
    mockComputeExpectedBilling.mockRejectedValue(new Error("db timeout"));
    const res = await request(makeApp(makeDb("standard"), "client_admin"))
      .get("/v1/admin/billing/quota")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(500);
  });
});
