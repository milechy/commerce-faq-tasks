// tests/phase54/billingDashboard.test.ts
// Phase54: テナント従量課金ダッシュボード API テスト

import express from "express";
import request from "supertest";
import { registerBillingAdminRoutes } from "../../src/lib/billing/billingApi";

// Stripe をモック
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
  }));
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

// ─── GET /v1/admin/billing/invoices ─────────────────────────────────────────

describe("GET /v1/admin/billing/invoices", () => {
  test("5: stripe_customer_id が存在しない → invoices: [] を返す（404 にしない）", async () => {
    const { app } = makeApp({ role: "client_admin", tenantId: "tenant-no-stripe", dbRows: [] });

    const res = await request(app)
      .get("/v1/admin/billing/invoices")
      .expect(200);

    expect(res.body.invoices).toEqual([]);
    expect(res.body.customerId).toBeNull();
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

    expect(res.body.total_yen).toBeGreaterThan(0);
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
