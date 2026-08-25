// tests/phase54/billingDashboard.test.ts
// Phase54: テナント従量課金ダッシュボード API テスト

import express from "express";
import request from "supertest";
import { registerBillingAdminRoutes, _resetMeteredPriceCacheForTest } from "../../src/lib/billing/billingApi";

// Stripe をモック
// PR-7: customers.create / subscriptions.create をテストごとに差し替えられるよう
// モジュールスコープの jest.fn() として外に出す(mock prefix はjestのhoist許可対象)。
// PR-5(2026-08-25収益監査): prices.retrieve は「今月の請求見積り」が使う実単価取得。
const mockCustomersCreate = jest.fn();
const mockSubscriptionsCreate = jest.fn();
const mockPricesRetrieve = jest.fn();
jest.mock("stripe", () => {
  return jest.fn().mockImplementation(() => ({
    invoices: {
      list: jest.fn().mockResolvedValue({ data: [] }),
    },
    billingPortal: {
      sessions: {
        create: jest.fn().mockResolvedValue({ url: "https://billing.stripe.com/portal/test" }),
      },
    },
    customers: {
      create: (...args: unknown[]) => mockCustomersCreate(...args),
    },
    subscriptions: {
      create: (...args: unknown[]) => mockSubscriptionsCreate(...args),
    },
    prices: {
      retrieve: (...args: unknown[]) => mockPricesRetrieve(...args),
    },
  }));
});

beforeEach(() => {
  // モジュールスコープの価格キャッシュ(billingApi.ts)がテスト間で漏れないようにする。
  _resetMeteredPriceCacheForTest();
});

// ── テスト用 Express アプリ生成 ───────────────────────────────────────────
function makeApp(opts: {
  role?: string;
  tenantId?: string | null;
  dbRows?: Record<string, unknown>[];
  dbError?: Error;
  dbCallbacks?: Record<string, Record<string, unknown>[]>;
}) {
  const { role = "client_admin", tenantId = "tenant-a" } = opts;

  const app = express();
  app.use(express.json());

  // supabaseAuthMiddleware の代替: req.supabaseUser をセット
  const authMw = (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      sub: "user-1",
      email: "test@example.com",
      app_metadata: { role, tenant_id: tenantId },
    };
    next();
  };

  // DB モック
  const db: any = {
    query: jest.fn().mockImplementation((...args: unknown[]) => {
      const sql = (args[0] as string).toLowerCase();
      if (opts.dbError) return Promise.reject(opts.dbError);
      if (opts.dbCallbacks) {
        for (const [key, rows] of Object.entries(opts.dbCallbacks)) {
          if (sql.includes(key)) return Promise.resolve({ rows, rowCount: rows.length });
        }
      }
      return Promise.resolve({ rows: opts.dbRows ?? [], rowCount: (opts.dbRows ?? []).length });
    }),
  };

  const logger: any = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

  registerBillingAdminRoutes(app, db, logger, [authMw]);
  return { app, db };
}

// ─── GET /v1/admin/billing/usage ────────────────────────────────────────────

describe("GET /v1/admin/billing/usage", () => {
  test("1: 正常系 — Client Admin が自テナントの集計を取得できる", async () => {
    const dailyRows = [
      {
        date: "2026-04-01",
        total_requests: 45,
        chat_requests: 30,
        avatar_requests: 10,
        voice_requests: 5,
        input_tokens: 1200,
        output_tokens: 800,
        cost_llm_cents: 500,
        cost_total_cents: 600,
        tts_text_bytes: 0,
        avatar_session_ms: 0,
      },
    ];
    const monthlyRows = [
      {
        month: "2026-04",
        total_requests: 45,
        chat_requests: 30,
        avatar_requests: 10,
        voice_requests: 5,
        input_tokens: 1200,
        output_tokens: 800,
        cost_llm_cents: 500,
        cost_total_cents: 600,
      },
    ];
    const { app } = makeApp({
      role: "client_admin",
      tenantId: "tenant-a",
      dbCallbacks: {
        "date(created_at)": dailyRows,
        "to_char(created_at": monthlyRows,
      },
    });

    const res = await request(app)
      .get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01")
      .expect(200);

    expect(res.body.tenantId).toBe("tenant-a");
    expect(res.body.daily).toHaveLength(1);
    expect(res.body.daily[0].input_tokens).toBe(1200);
    expect(res.body.daily[0].chat_requests).toBe(30);
    expect(res.body.monthly).toHaveLength(1);
  });

  test("2: データなし — 空の daily/monthly を返す", async () => {
    const { app } = makeApp({ role: "client_admin", tenantId: "tenant-b", dbRows: [] });

    const res = await request(app)
      .get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01")
      .expect(200);

    expect(res.body.daily).toEqual([]);
    expect(res.body.monthly).toEqual([]);
  });

  test("3: Client Admin が他テナント tenantId を渡しても JWT のテナントが使われる", async () => {
    const { app, db } = makeApp({ role: "client_admin", tenantId: "my-tenant", dbRows: [] });

    await request(app)
      .get("/v1/admin/billing/usage?tenantId=other-tenant")
      .expect(200);

    // DB クエリで tenant_id = 'my-tenant' が使われていること（other-tenant ではない）
    const calls: string[] = db.query.mock.calls.map((c: unknown[]) => c[1] as string[]).flat();
    expect(calls).toContain("my-tenant");
    expect(calls).not.toContain("other-tenant");
  });

  test("4: 認証なし（role=anonymous）→ 403", async () => {
    const { app } = makeApp({ role: "anonymous", tenantId: null, dbRows: [] });
    await request(app).get("/v1/admin/billing/usage").expect(403);
  });
});

// ─── GET /v1/admin/billing/usage — billing_estimate_jpy (PR-5) ─────────────
// 2026-08-25収益監査: 「今月の請求額」が原価×マージン(USD)を無変換で¥表示していた
// (禁止48違反)のを、Stripe実単価×billedQuantityの見積りに置き換えた。
describe("GET /v1/admin/billing/usage — billing_estimate_jpy(PR-5)", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIG_ENV, STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_METERED_PRICE_ID: "price_dummy" };
    mockPricesRetrieve.mockClear();
  });
  afterEach(() => {
    process.env = ORIG_ENV;
  });

  test("8: per_unit価格が取得できればbilledQuantity×単価の見積りを返す", async () => {
    mockPricesRetrieve.mockResolvedValueOnce({ billing_scheme: "per_unit", unit_amount: 500 });
    const { app } = makeApp({
      role: "client_admin",
      tenantId: "tenant-a",
      dbCallbacks: {
        "from tenants": [{ plan: "growth" }],
        "billed_units_weighted": [{
          total_requests: 10, total_cost_cents: 100, billable_units: 10,
          billed_units_weighted: "15", unstamped_rows: 0,
        }],
      },
    });

    const res = await request(app)
      .get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01")
      .expect(200);

    // billedQuantity=15(切り上げ済み) × 単価500円 = 7500円
    expect(res.body.billing_estimate_jpy).toBe(7500);
  });

  test("9: STRIPE_SECRET_KEY未設定はnull(0円ではない — 「今月は無料」と誤読させないため)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { app } = makeApp({ role: "client_admin", tenantId: "tenant-a", dbRows: [] });

    const res = await request(app)
      .get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01")
      .expect(200);

    expect(res.body.billing_estimate_jpy).toBeNull();
    expect(mockPricesRetrieve).not.toHaveBeenCalled();
  });

  test("10: Stripe priceが段階制(tiered)等でunit_amountが取れない場合はnullに倒す(推測しない)", async () => {
    mockPricesRetrieve.mockResolvedValueOnce({ billing_scheme: "tiered", unit_amount: null });
    const { app } = makeApp({
      role: "client_admin",
      tenantId: "tenant-a",
      dbCallbacks: {
        "from tenants": [{ plan: "growth" }],
        "billed_units_weighted": [{
          total_requests: 10, total_cost_cents: 100, billable_units: 10,
          billed_units_weighted: "15", unstamped_rows: 0,
        }],
      },
    });

    const res = await request(app)
      .get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01")
      .expect(200);

    expect(res.body.billing_estimate_jpy).toBeNull();
  });

  test("11: from/toを指定しない横断ビュー(tenantId=all)はStripe呼び出しなしでnull", async () => {
    const { app } = makeApp({ role: "super_admin", tenantId: null, dbRows: [] });

    const res = await request(app).get("/v1/admin/billing/usage").expect(200);

    expect(res.body.billing_estimate_jpy).toBeNull();
    expect(mockPricesRetrieve).not.toHaveBeenCalled();
  });

  test("12: 価格は15分キャッシュされ、2回目の呼び出しではStripeを再度叩かない", async () => {
    mockPricesRetrieve.mockResolvedValueOnce({ billing_scheme: "per_unit", unit_amount: 500 });
    const { app } = makeApp({
      role: "client_admin",
      tenantId: "tenant-a",
      dbCallbacks: {
        "from tenants": [{ plan: "growth" }],
        "billed_units_weighted": [{
          total_requests: 10, total_cost_cents: 100, billable_units: 10,
          billed_units_weighted: "1", unstamped_rows: 0,
        }],
      },
    });

    await request(app).get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01").expect(200);
    await request(app).get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01").expect(200);

    expect(mockPricesRetrieve).toHaveBeenCalledTimes(1);
  });
});

// ─── GET /v1/admin/billing/invoices ─────────────────────────────────────────

describe("GET /v1/admin/billing/invoices", () => {
  test("5: stripe_customer_id が存在しない → invoices: [] を返す（404 にしない）", async () => {
    const { app } = makeApp({ role: "client_admin", tenantId: "tenant-no-stripe", dbRows: [] });

    const res = await request(app)
      .get("/v1/admin/billing/invoices")
      .expect(200);

    expect(res.body.invoices).toEqual([]);
    expect(res.body.customerId).toBeNull();
    // PR-7(2026-08-25収益監査): 「未登録」と「登録済みだが偶然0件」を同じ値で
    // 表現しない(CLAUDE.md禁止20)。status で明示的に区別する。
    expect(res.body.status).toBe("no_subscription");
  });
});

// ─── POST /v1/admin/billing/onboard ─────────────────────────────────────────
// PR-7(2026-08-25収益監査): リポジトリ全体に customers.create / subscriptions.create が
// 1件も存在せず、サブスク行が無いテナントは決済手段登録に到達不能だった。
describe("POST /v1/admin/billing/onboard", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIG_ENV, STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_METERED_PRICE_ID: "price_dummy" };
    mockCustomersCreate.mockResolvedValue({ id: "cus_new_001" });
    mockSubscriptionsCreate.mockResolvedValue({ id: "sub_new_001" });
  });

  afterAll(() => {
    process.env = ORIG_ENV;
  });

  test("8: 正常系 — Customer + Subscription を作成し stripe_subscriptions に記録する", async () => {
    const { app, db } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [], // 未登録
        "select id, name, tenant_contact_email from tenants": [
          { id: "tenant-onboard", name: "テストテナント", tenant_contact_email: "owner@example.com" },
        ],
      },
    });

    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "tenant-onboard" })
      .expect(200);

    expect(res.body).toEqual({
      ok: true,
      alreadyOnboarded: false,
      subscriptionId: "sub_new_001",
      customerId: "cus_new_001",
    });
    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "テストテナント", email: "owner@example.com" })
    );
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new_001", items: [{ price: "price_dummy" }] })
    );
    // DBに書き込まれたことを確認(ON CONFLICT DO UPDATE を含む1行のINSERT)
    const insertCall = db.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).toLowerCase().includes("insert into stripe_subscriptions")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual(["tenant-onboard", "cus_new_001", "sub_new_001", "price_dummy"]);
  });

  test("9: 既にアクティブなサブスクがあれば冪等に既存値を返し、Stripe APIを呼ばない(重複作成防止)", async () => {
    const { app } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [
          { stripe_subscription_id: "sub_existing", stripe_customer_id: "cus_existing" },
        ],
      },
    });

    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "tenant-already" })
      .expect(200);

    expect(res.body).toEqual({
      ok: true,
      alreadyOnboarded: true,
      subscriptionId: "sub_existing",
      customerId: "cus_existing",
    });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  test("10: client_admin は 403(super_admin限定)", async () => {
    const { app } = makeApp({ role: "client_admin", tenantId: "tenant-a" });
    await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "tenant-a" })
      .expect(403);
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  test("11: STRIPE_SECRET_KEY未設定は500・Stripeを呼ばない", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { app } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [],
      },
    });

    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "tenant-no-key" })
      .expect(500);

    expect(res.body).toEqual({ error: "stripe_not_configured" });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  test("12: STRIPE_METERED_PRICE_ID未設定は500・Customerも作成しない", async () => {
    delete process.env.STRIPE_METERED_PRICE_ID;
    const { app } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [],
      },
    });

    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "tenant-no-price" })
      .expect(500);

    expect(res.body).toEqual({ error: "stripe_price_not_configured" });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  test("13: 存在しないtenantIdは404", async () => {
    const { app } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [],
        "select id, name, tenant_contact_email from tenants": [],
      },
    });

    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "tenant-not-exist" })
      .expect(404);

    expect(res.body).toEqual({ error: "tenant not found" });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  test("14: tenantId未指定は400", async () => {
    const { app } = makeApp({ role: "super_admin", tenantId: null });
    await request(app)
      .post("/v1/admin/billing/onboard")
      .send({})
      .expect(400);
  });

  test("15: 過去に解約済み(is_active=false)のテナントも再オンボーディングできる(tenant_idがPRIMARY KEYのためON CONFLICTで受ける)", async () => {
    // is_active=true の行は無い(WHERE is_active=trueで0件) → 新規作成フローに進む。
    // ただしDB上には解約済みの行(is_active=false)が既に存在する想定。
    const { app, db } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [],
        "select id, name, tenant_contact_email from tenants": [
          { id: "tenant-rejoin", name: "再開テナント", tenant_contact_email: null },
        ],
      },
    });

    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "tenant-rejoin" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.alreadyOnboarded).toBe(false);
    const insertCall = db.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).toLowerCase().includes("insert into stripe_subscriptions")
    );
    expect(insertCall![0]).toMatch(/on conflict \(tenant_id\) do update/i);
  });
});

// ─── GET /v1/admin/billing/cost-breakdown ───────────────────────────────────

describe("GET /v1/admin/billing/cost-breakdown", () => {
  test("6: 正常系 — feature_used 別に集計して percentage を返す", async () => {
    const breakdownRows = [
      { feature_used: "chat",   request_count: 30, llm_cents: 300, total_cents: 360 },
      { feature_used: "avatar", request_count: 10, llm_cents: 100, total_cents: 120 },
      { feature_used: "voice",  request_count:  5, llm_cents:  50, total_cents:  60 },
    ];
    const { app } = makeApp({ role: "client_admin", tenantId: "tenant-a", dbRows: breakdownRows });

    const res = await request(app)
      .get("/v1/admin/billing/cost-breakdown?from=2026-04-01&to=2026-05-01")
      .expect(200);

    expect(res.body.total_usd).toBeGreaterThan(0);
    expect(res.body.breakdown).toBeDefined();
    const chat = res.body.breakdown.chat;
    expect(chat.label).toBe("AI応答");
    expect(chat.percentage).toBeGreaterThan(0);
  });

  test("7: 認証なし → 403", async () => {
    const { app } = makeApp({ role: "anonymous", tenantId: null, dbRows: [] });
    await request(app).get("/v1/admin/billing/cost-breakdown").expect(403);
  });
});
