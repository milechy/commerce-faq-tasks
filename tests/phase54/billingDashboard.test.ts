// tests/phase54/billingDashboard.test.ts
// Phase54: テナント従量課金ダッシュボード API テスト

import express from "express";
import request from "supertest";
import { registerBillingAdminRoutes, _resetPriceCacheForTest } from "../../src/lib/billing/billingApi";

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
  // UX-B(2026-08-26)でキャッシュが単一値からprice ID別Mapに変わり、関数名も
  // _resetPriceCacheForTest にリネームされた(computeBillingEstimateJpyの書き換え)。
  _resetPriceCacheForTest();
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
//
// UX-B(2026-08-26)で computeBillingEstimateJpy 自体を書き換えた: 単一の
// STRIPE_METERED_PRICE_ID(全プラン共通)× billedQuantity(倍率込み)という旧式は
// #1015(Standard/Growthを「基本料+込み枠+超過」に変更)後は倍率の二重適用に
// なっていたため、getSubscriptionItemPrices(planPricing.ts)を唯一の出どころに
// した新式へ置き換えた。以下のテストはstarterプラン(基本料も込み枠も無い純従量
// = 会話数×単価のみ)を使い、旧テストの「15件×500円=7500円」という検証意図は
// そのまま保ちつつ、新式の入力(textUnits・STRIPE_PRICE_STARTER_TEXT)に合わせて
// 書き直した。standard/growthの基本料+込み枠超過の計算式そのものは
// src/lib/billing/billingApi.estimate.test.ts が直接(HTTP層を介さず)網羅する。
describe("GET /v1/admin/billing/usage — billing_estimate_jpy(PR-5, UX-B)", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIG_ENV, STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_PRICE_STARTER_TEXT: "price_starter_text" };
    mockPricesRetrieve.mockClear();
  });
  afterEach(() => {
    process.env = ORIG_ENV;
  });

  test("8: per_unit価格が取得できれば会話数×単価の見積りを返す(starter=純従量)", async () => {
    mockPricesRetrieve.mockResolvedValueOnce({ billing_scheme: "per_unit", unit_amount: 500 });
    const { app } = makeApp({
      role: "client_admin",
      tenantId: "tenant-a",
      dbCallbacks: {
        "from tenants": [{ plan: "starter" }],
        "billed_units_weighted": [{
          total_requests: 10, total_cost_cents: 100, billable_units: 10,
          billed_units_weighted: "15", unstamped_rows: 0, text_units: 15, avatar_minutes: 0,
        }],
      },
    });

    const res = await request(app)
      .get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01")
      .expect(200);

    // 会話数15件 × 単価500円 = 7500円(倍率を掛けない。旧billedQuantity=15とは
    // 別の理由で同じ数字になっているだけなので混同しないこと)
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
        "from tenants": [{ plan: "starter" }],
        "billed_units_weighted": [{
          total_requests: 10, total_cost_cents: 100, billable_units: 10,
          billed_units_weighted: "15", unstamped_rows: 0, text_units: 15, avatar_minutes: 0,
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
        "from tenants": [{ plan: "starter" }],
        "billed_units_weighted": [{
          total_requests: 10, total_cost_cents: 100, billable_units: 10,
          billed_units_weighted: "1", unstamped_rows: 0, text_units: 1, avatar_minutes: 0,
        }],
      },
    });

    await request(app).get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01").expect(200);
    await request(app).get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01").expect(200);

    expect(mockPricesRetrieve).toHaveBeenCalledTimes(1);
  });

  // ★UX-Bで新規に生まれた分岐: standard/growthの基本料+込み枠超過★
  // starter系(#8-12)は単一price呼び出しで完結するが、standard/growthは
  // 基本料・テキスト超過・アバター超過の3価格を同時に見る。HTTP層を介しても
  // 3価格が正しく合成されることをここで固定する(内訳の単体テストは
  // billingApi.estimate.test.ts が既に網羅済みなので、ここでは配線の確認に絞る)。
  test("13: standardは基本料+込み枠超過(テキスト・アバター)の3価格を合成した見積りを返す", async () => {
    process.env.STRIPE_PRICE_STANDARD_BASE_MONTHLY = "price_std_base";
    process.env.STRIPE_PRICE_STANDARD_TEXT_OVERAGE = "price_std_text";
    process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE = "price_std_avatar";
    mockPricesRetrieve
      .mockResolvedValueOnce({ billing_scheme: "per_unit", unit_amount: 9800 })  // 基本料
      .mockResolvedValueOnce({ billing_scheme: "per_unit", unit_amount: 25 })    // テキスト超過
      .mockResolvedValueOnce({ billing_scheme: "per_unit", unit_amount: 100 });  // アバター超過
    const { app } = makeApp({
      role: "client_admin",
      tenantId: "tenant-a",
      dbCallbacks: {
        "from tenants": [{ plan: "standard" }],
        // 込み枠(1,000会話/30分)を text_units=1200・avatar_minutes=45 で超過させる
        "billed_units_weighted": [{
          total_requests: 10, total_cost_cents: 100, billable_units: 10,
          billed_units_weighted: "0", unstamped_rows: 0, text_units: 1200, avatar_minutes: 45,
        }],
      },
    });

    const res = await request(app)
      .get("/v1/admin/billing/usage?from=2026-04-01&to=2026-05-01")
      .expect(200);

    // 9800 + (1200-1000)*25 + (45-30)*100 = 9800 + 5000 + 1500 = 16300
    expect(res.body.billing_estimate_jpy).toBe(16300);
    delete process.env.STRIPE_PRICE_STANDARD_BASE_MONTHLY;
    delete process.env.STRIPE_PRICE_STANDARD_TEXT_OVERAGE;
    delete process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE;
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
        "select id, name, tenant_contact_email, plan from tenants": [
          { id: "tenant-onboard", name: "テストテナント", tenant_contact_email: "owner@example.com", plan: "starter" },
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

  // price の選択はプラン依存になったため、この検査はテナント取得より後になる
  // (どの price を要求すべきかはプランを見ないと決まらない)。
  test("12: price のenvが未設定なら500・Customerも作成しない", async () => {
    delete process.env.STRIPE_METERED_PRICE_ID;
    delete process.env.STRIPE_PRICE_STARTER_TEXT;
    const { app } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [],
        "select id, name, tenant_contact_email, plan from tenants": [
          { id: "tenant-no-price", name: "価格未設定", tenant_contact_email: null, plan: "starter" },
        ],
      },
    });

    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "tenant-no-price" })
      .expect(500);

    expect(res.body.error).toBe("stripe_price_not_configured");
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  test("13: 存在しないtenantIdは404", async () => {
    const { app } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [],
        "select id, name, tenant_contact_email, plan from tenants": [],
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
        "select id, name, tenant_contact_email, plan from tenants": [
          { id: "tenant-rejoin", name: "再開テナント", tenant_contact_email: null, plan: "starter" },
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

// ─── POST /v1/admin/billing/onboard（プラン別 item 構成）────────────────────
// 確定価格(.claude/rules/billing.md §7)では、Standard/Growth は
// 「基本料(定額) + テキスト超過(従量) + アバター超過(従量)」の3 item 構成になる。
// 純従量の Starter は従来どおり1 item のまま。
describe("POST /v1/admin/billing/onboard（プラン別の item 構成）", () => {
  const ORIG_ENV = process.env;

  const PRICE_ENV = {
    STRIPE_PRICE_STARTER_TEXT:            "price_starter_text",
    STRIPE_PRICE_STANDARD_BASE_MONTHLY:   "price_std_base_m",
    STRIPE_PRICE_STANDARD_BASE_ANNUAL:    "price_std_base_y",
    STRIPE_PRICE_STANDARD_TEXT_OVERAGE:   "price_std_text",
    STRIPE_PRICE_STANDARD_AVATAR_OVERAGE: "price_std_avatar",
    STRIPE_PRICE_GROWTH_BASE_MONTHLY:     "price_gro_base_m",
    STRIPE_PRICE_GROWTH_BASE_ANNUAL:      "price_gro_base_y",
    STRIPE_PRICE_GROWTH_TEXT_OVERAGE:     "price_gro_text",
    STRIPE_PRICE_GROWTH_AVATAR_OVERAGE:   "price_gro_avatar",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIG_ENV, STRIPE_SECRET_KEY: "sk_test_dummy", ...PRICE_ENV };
    mockCustomersCreate.mockResolvedValue({ id: "cus_p" });
    mockSubscriptionsCreate.mockResolvedValue({ id: "sub_p" });
  });
  afterAll(() => { process.env = ORIG_ENV; });

  function appForPlan(plan: string | null) {
    return makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [],
        "select id, name, tenant_contact_email, plan from tenants": [
          { id: "t-plan", name: "プランテナント", tenant_contact_email: null, plan },
        ],
      },
    });
  }

  /** stripe_subscriptions へ書かれた stripe_price_id(第4パラメータ)を取り出す。 */
  function storedPriceId(db: any): unknown {
    const call = db.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" &&
        (c[0] as string).toLowerCase().includes("insert into stripe_subscriptions")
    );
    return call![1][3];
  }

  test("Standard(月払い) は 基本料 + テキスト超過 + アバター超過 の3 item を作る", async () => {
    const { app, db } = appForPlan("standard");
    await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan" })
      .expect(200);

    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_p",
        items: [
          { price: "price_std_base_m" },
          { price: "price_std_text" },
          { price: "price_std_avatar" },
        ],
      })
    );
    // stripe_price_id は単数列。プランを代表する基本料の price を入れる。
    expect(storedPriceId(db)).toBe("price_std_base_m");
  });

  // ★2026-08-26 実地確認: Stripeは1subscription内の全priceが同じrecurring.intervalで
  // あることを要求する。年払い基本料(interval=year)と超過2本(interval=month、
  // 年次variant無し)を混在させるとStripe test-modeで実際にinvalid_request_errorに
  // なることを確認した。恒久対応(flexible billing modeへの全社apiVersion移行、
  // または年払い基本料を単発invoiceItemsで請求する設計)ができるまでブロックする。
  test("Standard(年払い)は現状400でブロックする(Stripeのinterval混在制約のため、Stripeを一切呼ばない)", async () => {
    const { app } = appForPlan("standard");
    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan", billingCycle: "annual" })
      .expect(400);

    expect(res.body.error).toBe("billing_cycle_not_supported");
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  test("Growth は Growth 専用の3 item を作る(Standard の price が混ざらない)", async () => {
    const { app } = appForPlan("growth");
    await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan", billingCycle: "monthly" })
      .expect(200);

    const items = mockSubscriptionsCreate.mock.calls[0][0].items;
    expect(items).toEqual([
      { price: "price_gro_base_m" },
      { price: "price_gro_text" },
      { price: "price_gro_avatar" },
    ]);
    expect(JSON.stringify(items)).not.toContain("std");
  });

  // 回帰: 純従量プランの構成を、込み枠プランの追加で壊していないこと。
  test("Starter は従来どおり 1 item のまま(基本料も込み枠も作らない)", async () => {
    const { app, db } = appForPlan("starter");
    await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan" })
      .expect(200);

    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ price: "price_starter_text" }] })
    );
    expect(storedPriceId(db)).toBe("price_starter_text");
  });

  test("plan が NULL のテナントは Starter として 1 item で作る(請求漏れを避ける向きのfail-safe)", async () => {
    const { app } = appForPlan(null);
    await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan" })
      .expect(200);
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ price: "price_starter_text" }] })
    );
  });

  test("free_ad は 400 で拒否し、Stripe に一切触れない(倍率0で請求が発生しないため)", async () => {
    const { app } = appForPlan("free_ad");
    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan" })
      .expect(400);

    expect(res.body.error).toBe("plan_not_self_serve");
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  test("enterprise は 400 で拒否し、手動作成を促す(個別交渉を自動化しない)", async () => {
    const { app } = appForPlan("enterprise");
    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan" })
      .expect(400);

    expect(res.body.error).toBe("plan_not_self_serve");
    expect(res.body.detail).toContain("Enterprise");
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  test("Starter に annual を指定したら 400(黙って月払いに倒さない)", async () => {
    const { app } = appForPlan("starter");
    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan", billingCycle: "annual" })
      .expect(400);

    expect(res.body.error).toBe("billing_cycle_not_supported");
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  test("billingCycle に未知の値を渡したら 400(zod)", async () => {
    const { app } = appForPlan("standard");
    await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan", billingCycle: "weekly" })
      .expect(400);
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  // 込み枠プランの price が一部しか設定されていない状態で作ると、欠けた次元の
  // 超過が「請求されないまま誰も気づかない」状態になる(禁止50 と同型)。
  test("Standard の price が一部欠けていたら作成せず 500 + 欠けた env 名を返す", async () => {
    delete process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE;
    const { app } = appForPlan("standard");
    const res = await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan" })
      .expect(500);

    expect(res.body.error).toBe("stripe_price_not_configured");
    expect(res.body.missing).toEqual(["STRIPE_PRICE_STANDARD_AVATAR_OVERAGE"]);
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  // 解約 → プラン変更 → 再オンボーディング。ON CONFLICT で受ける既存の冪等経路が、
  // 古いプランの item 構成を引き継がず「現在の」プランで作り直すこと。
  test("解約後にプランが変わっていたら、現在のプランの item 構成で作り直す", async () => {
    const { app, db } = makeApp({
      role: "super_admin",
      tenantId: null,
      dbCallbacks: {
        // is_active=true の行は無い(解約済み)
        "select stripe_subscription_id, stripe_customer_id from stripe_subscriptions": [],
        "select id, name, tenant_contact_email, plan from tenants": [
          { id: "t-plan", name: "昇格テナント", tenant_contact_email: null, plan: "growth" },
        ],
      },
    });

    await request(app)
      .post("/v1/admin/billing/onboard")
      .send({ tenantId: "t-plan" })
      .expect(200);

    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          { price: "price_gro_base_m" },
          { price: "price_gro_text" },
          { price: "price_gro_avatar" },
        ],
      })
    );
    const insertCall = db.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" &&
        (c[0] as string).toLowerCase().includes("insert into stripe_subscriptions")
    );
    expect(insertCall![0]).toMatch(/on conflict \(tenant_id\) do update/i);
    expect(insertCall![1][3]).toBe("price_gro_base_m");
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
