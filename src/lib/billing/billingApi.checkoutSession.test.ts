// src/lib/billing/billingApi.checkoutSession.test.ts
// POST /v1/admin/my-tenant/billing/checkout-session — テナント自身によるセルフサービス決済登録。
//
// ★このテストが守っている事故★
// 有料プラン(Standard/Growth)へ変更しても、テナント自身がカードを登録する導線が
// 無かった(super_admin限定の /billing/onboard しか無い)。基本料ありのプランは
// subscriptions.create が即座に課金を試みるため、カード未登録だと subscription が
// incomplete で止まる。Checkout(mode: subscription)でカード入力をStripe側に任せる。

import express from "express";
import request from "supertest";
import pino from "pino";
import { registerBillingAdminRoutes } from "./billingApi";

const mockCheckoutSessionsCreate = jest.fn();
const mockPortalSessionsCreate = jest.fn();

// ★{virtual:true}を付けない★ 'stripe' は実在パッケージなので不要かつ有害
// (詳細は stripeWebhook.test.ts の同種コメント参照。フルスイート実行時に
// 他ファイルの'stripe'モックと競合し、無関係なテストファイルが全滅する)。
jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: (...args: unknown[]) => mockCheckoutSessionsCreate(...args) } },
    billingPortal: { sessions: { create: (...args: unknown[]) => mockPortalSessionsCreate(...args) } },
  }));
});

const silentLogger = pino({ level: "silent" });

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

function makeDb(
  tenant: { plan: string | null; tenantContactEmail?: string | null } | null,
  opts: { activeSubscriptionCustomerId?: string } = {},
) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("SELECT id, name, tenant_contact_email, plan FROM tenants")) {
        return tenant
          ? { rows: [{ id: "tenant-a", name: "テストテナント", tenant_contact_email: tenant.tenantContactEmail ?? null, plan: tenant.plan }] }
          : { rows: [] };
      }
      if (sql.includes("FROM stripe_subscriptions") && sql.includes("is_active = true")) {
        return opts.activeSubscriptionCustomerId
          ? { rows: [{ stripe_customer_id: opts.activeSubscriptionCustomerId }] }
          : { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_STANDARD_BASE_MONTHLY",
  "STRIPE_PRICE_STANDARD_TEXT_OVERAGE",
  "STRIPE_PRICE_STANDARD_AVATAR_OVERAGE",
  "STRIPE_PRICE_GROWTH_BASE_MONTHLY",
  "STRIPE_PRICE_GROWTH_TEXT_OVERAGE",
  "STRIPE_PRICE_GROWTH_AVATAR_OVERAGE",
  "STRIPE_PRICE_STARTER_TEXT",
  "BILLING_PORTAL_RETURN_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_STANDARD_BASE_MONTHLY = "price_std_base";
  process.env.STRIPE_PRICE_STANDARD_TEXT_OVERAGE = "price_std_text";
  process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE = "price_std_avatar";
  process.env.STRIPE_PRICE_GROWTH_BASE_MONTHLY = "price_growth_base";
  process.env.STRIPE_PRICE_GROWTH_TEXT_OVERAGE = "price_growth_text";
  process.env.STRIPE_PRICE_GROWTH_AVATAR_OVERAGE = "price_growth_avatar";
  process.env.STRIPE_PRICE_STARTER_TEXT = "price_starter_text";
  process.env.BILLING_PORTAL_RETURN_URL = "https://app.example.com/billing";
  mockCheckoutSessionsCreate.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.com/cs_test_1" });
  mockPortalSessionsCreate.mockResolvedValue({ id: "bps_test_1", url: "https://billing.stripe.com/session/bps_test_1" });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

describe("POST /v1/admin/my-tenant/billing/checkout-session", () => {
  it("client_admin が standard プランで Checkout セッションを作成し、redirect先URLを返す", async () => {
    const db = makeDb({ plan: "standard" });
    const res = await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.stripe.com/cs_test_1");
    expect(mockCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
  });

  // ★基本料(licensed)には quantity:1、超過(metered)には quantity を付けない★
  // Stripe Checkout は metered price に quantity を渡すと拒否する。
  it("基本料には quantity:1 を、超過(metered)には quantity を付けずに line_items を組む", async () => {
    const db = makeDb({ plan: "standard" });
    await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    const arg = mockCheckoutSessionsCreate.mock.calls[0][0];
    expect(arg.line_items).toEqual([
      { price: "price_std_base", quantity: 1 },
      { price: "price_std_text" },
      { price: "price_std_avatar" },
    ]);
  });

  it("mode: subscription と tenant_id を含む metadata を渡す(webhook側の突合に必須)", async () => {
    const db = makeDb({ plan: "growth" });
    await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    const arg = mockCheckoutSessionsCreate.mock.calls[0][0];
    expect(arg.mode).toBe("subscription");
    expect(arg.metadata.tenant_id).toBe("tenant-a");
    expect(arg.subscription_data.metadata.tenant_id).toBe("tenant-a");
  });

  it("super_admin(集約ビュー)は利用不可 — テナントに紐付かないため 403", async () => {
    const db = makeDb({ plan: "standard" });
    const res = await request(makeApp(db, "super_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    expect(res.status).toBe(403);
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("free_ad は請求が発生しないため plan_not_self_serve で 400", async () => {
    const db = makeDb({ plan: "free_ad" });
    const res = await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("plan_not_self_serve");
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("enterprise は個別契約のため plan_not_self_serve で 400", async () => {
    const db = makeDb({ plan: "enterprise" });
    const res = await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("plan_not_self_serve");
  });

  it("starter に annual を指定すると billing_cycle_not_supported で 400", async () => {
    const db = makeDb({ plan: "starter" });
    const res = await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({ billingCycle: "annual" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("billing_cycle_not_supported");
  });

  it("price の env が欠けていれば 500 stripe_price_not_configured を返す(黙って作らない)", async () => {
    delete process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE;
    const db = makeDb({ plan: "standard" });
    const res = await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("stripe_price_not_configured");
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("STRIPE_SECRET_KEY が無ければ 500 stripe_not_configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const db = makeDb({ plan: "standard" });
    const res = await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("stripe_not_configured");
  });

  it("存在しないテナントは404", async () => {
    const db = makeDb(null);
    const res = await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    expect(res.status).toBe(404);
  });

  it("tenant_contact_email が設定されていれば customer_email として渡す", async () => {
    const db = makeDb({ plan: "standard", tenantContactEmail: "owner@example.com" });
    await request(makeApp(db, "client_admin"))
      .post("/v1/admin/my-tenant/billing/checkout-session")
      .set("Authorization", "Bearer dummy")
      .send({});

    const arg = mockCheckoutSessionsCreate.mock.calls[0][0];
    expect(arg.customer_email).toBe("owner@example.com");
  });

  // ★このブロックが本エンドポイントの最重要リグレッションガード★
  // 二重クリック・ネットワーク遅延中の再送・古いUI状態での再訪問のいずれでも
  // 「テナントごとに1本のはずのStripe契約」を複数作ってしまうと二重請求になる。
  describe("冪等性 — 既にアクティブな契約があるテナントの再訪問(GID Checkout重複防止)", () => {
    it("既にアクティブな契約がある場合は新規Checkoutを作らず、Billing Portalへ誘導する", async () => {
      const db = makeDb({ plan: "standard" }, { activeSubscriptionCustomerId: "cus_existing" });
      const res = await request(makeApp(db, "client_admin"))
        .post("/v1/admin/my-tenant/billing/checkout-session")
        .set("Authorization", "Bearer dummy")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.url).toBe("https://billing.stripe.com/session/bps_test_1");
      expect(res.body.alreadyOnboarded).toBe(true);
      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
      expect(mockPortalSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_existing" })
      );
    });

    // 既存の停止済み(is_active=false)契約は「既にアクティブ」に該当しない。
    // free_ad解約後の再アップグレード等、正当に新しいCheckoutが必要なケースを
    // 誤ってブロックしない。
    it("既存契約が is_active=false(解約済み)なら通常どおり新規Checkoutを作る", async () => {
      const db = makeDb({ plan: "standard" }); // activeSubscriptionCustomerId 省略 = is_active=true の行なし
      const res = await request(makeApp(db, "client_admin"))
        .post("/v1/admin/my-tenant/billing/checkout-session")
        .set("Authorization", "Bearer dummy")
        .send({});

      expect(res.status).toBe(200);
      expect(mockCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
      expect(mockPortalSessionsCreate).not.toHaveBeenCalled();
    });

    it("Portalセッション作成が失敗したら500を返し、Checkoutへフォールバックしない(二重契約より安全側)", async () => {
      mockPortalSessionsCreate.mockRejectedValue(new Error("stripe portal error"));
      const db = makeDb({ plan: "standard" }, { activeSubscriptionCustomerId: "cus_existing" });
      const res = await request(makeApp(db, "client_admin"))
        .post("/v1/admin/my-tenant/billing/checkout-session")
        .set("Authorization", "Bearer dummy")
        .send({});

      expect(res.status).toBe(500);
      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    // ★上の existing チェックは TOCTOU(SELECTとcreateの間にロックが無い)★
    // ほぼ同時の2リクエストは両方とも「既存契約なし」を見て通過しうるため、
    // 最終防衛線として Stripe の冪等キーを渡す。ここが外れると、同時実行時に
    // Customer/Subscription が2本作られる(=二重請求)。
    describe("Stripe冪等キー(TOCTOUの最終防衛線)", () => {
      it("checkout.sessions.create に idempotencyKey を渡す", async () => {
        const db = makeDb({ plan: "standard" });
        await request(makeApp(db, "client_admin"))
          .post("/v1/admin/my-tenant/billing/checkout-session")
          .set("Authorization", "Bearer dummy")
          .send({});

        const options = mockCheckoutSessionsCreate.mock.calls[0][1];
        expect(options).toBeDefined();
        expect(typeof options.idempotencyKey).toBe("string");
        expect(options.idempotencyKey).toContain("tenant-a");
      });

      // 連打(数百ms〜数秒)は同一キーに畳まれ、Stripe側で1回に収束する。
      it("短時間の連続リクエストでは同じ idempotencyKey になる", async () => {
        const db = makeDb({ plan: "standard" });
        const app = makeApp(db, "client_admin");

        await request(app).post("/v1/admin/my-tenant/billing/checkout-session").set("Authorization", "Bearer dummy").send({});
        await request(app).post("/v1/admin/my-tenant/billing/checkout-session").set("Authorization", "Bearer dummy").send({});

        const key1 = mockCheckoutSessionsCreate.mock.calls[0][1].idempotencyKey;
        const key2 = mockCheckoutSessionsCreate.mock.calls[1][1].idempotencyKey;
        expect(key1).toBe(key2);
      });

      // ★テナント固定キーにしていないことの確認★
      // 固定にすると「離脱して後日やり直す」がStripe側で24時間ブロックされる。
      // プランが違えば別の契約なので、必ず別キーでなければならない。
      it("プランが違えば別の idempotencyKey になる(別契約を同一キーで潰さない)", async () => {
        const app1 = makeApp(makeDb({ plan: "standard" }), "client_admin");
        const app2 = makeApp(makeDb({ plan: "growth" }), "client_admin");

        await request(app1).post("/v1/admin/my-tenant/billing/checkout-session").set("Authorization", "Bearer dummy").send({});
        await request(app2).post("/v1/admin/my-tenant/billing/checkout-session").set("Authorization", "Bearer dummy").send({});

        const key1 = mockCheckoutSessionsCreate.mock.calls[0][1].idempotencyKey;
        const key2 = mockCheckoutSessionsCreate.mock.calls[1][1].idempotencyKey;
        expect(key1).not.toBe(key2);
      });

      it("テナントが違えば別の idempotencyKey になる(テナント境界)", async () => {
        const app1 = makeApp(makeDb({ plan: "standard" }), "client_admin", "tenant-a");
        const app2 = makeApp(makeDb({ plan: "standard" }), "client_admin", "tenant-b");

        await request(app1).post("/v1/admin/my-tenant/billing/checkout-session").set("Authorization", "Bearer dummy").send({});
        await request(app2).post("/v1/admin/my-tenant/billing/checkout-session").set("Authorization", "Bearer dummy").send({});

        const key1 = mockCheckoutSessionsCreate.mock.calls[0][1].idempotencyKey;
        const key2 = mockCheckoutSessionsCreate.mock.calls[1][1].idempotencyKey;
        expect(key1).not.toBe(key2);
        expect(key1).toContain("tenant-a");
        expect(key2).toContain("tenant-b");
      });
    });
  });
});
