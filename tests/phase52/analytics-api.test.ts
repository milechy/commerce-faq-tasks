// tests/phase52/analytics-api.test.ts
// Phase52: Analytics API — score>0フィルタと認証テスト

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock DB pool
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();

jest.mock("../../src/lib/db", () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
  },
}));

// Auth middleware — real middleware replaced with passthrough by default
const mockAuthMiddleware = jest.fn((_req: any, _res: any, next: any) => next());

jest.mock("../../src/admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (...args: any[]) => mockAuthMiddleware(...args),
}));

import { registerAnalyticsRoutes } from "../../src/api/admin/analytics/routes";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(role: Role = "client_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      email: "test@example.com",
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });
  registerAnalyticsRoutes(app);
  return app;
}

function makeUnauthApp() {
  const app = express();
  app.use(express.json());
  // No supabaseUser injection
  registerAnalyticsRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupSummaryMocks() {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ total_sessions: "12" }] })
    .mockResolvedValueOnce({ rows: [{ prev_total_sessions: "10" }] })
    .mockResolvedValueOnce({ rows: [{ avg_judge_score: "75.0" }] }) // score > 0 only
    .mockResolvedValueOnce({ rows: [{ total_knowledge_gaps: "5" }] })
    .mockResolvedValueOnce({ rows: [{ avg_messages_per_session: "5.2" }] })
    .mockResolvedValueOnce({ rows: [{ avatar_session_count: "3" }] })
    .mockResolvedValueOnce({ rows: [] })  // sentiment
    .mockResolvedValueOnce({ rows: [] })  // Phase65-3: CV aggregation
    .mockResolvedValueOnce({ rows: [{ days: 30 }] }); // Phase65-3: tenant age (used when tenantId set)
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: auth passes through
  mockAuthMiddleware.mockImplementation((_req: any, _res: any, next: any) => next());
});

// ---------------------------------------------------------------------------
// 1. super_admin — 全テナントデータ取得
// ---------------------------------------------------------------------------

describe("1. GET /v1/admin/analytics/summary — super_admin", () => {
  it("super_admin: tenant_id = null (全テナント)", async () => {
    setupSummaryMocks();
    const res = await request(makeApp("super_admin"))
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBeNull();
    expect(res.body.total_sessions).toBe(12);
  });

  it("super_admin: ?tenant= で特定テナント絞り込み可", async () => {
    setupSummaryMocks();
    const res = await request(makeApp("super_admin"))
      .get("/v1/admin/analytics/summary?tenant=tenant-x");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe("tenant-x");
  });
});

// ---------------------------------------------------------------------------
// 2. client_admin — 自テナントのみ
// ---------------------------------------------------------------------------

describe("2. GET /v1/admin/analytics/summary — client_admin", () => {
  it("client_admin: 自テナントのみ取得", async () => {
    setupSummaryMocks();
    const res = await request(makeApp("client_admin", "tenant-mine"))
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe("tenant-mine");
  });

  it("client_admin: ?tenant=other を渡しても自テナントが使われる", async () => {
    setupSummaryMocks();
    const res = await request(makeApp("client_admin", "tenant-mine"))
      .get("/v1/admin/analytics/summary?tenant=other-tenant");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe("tenant-mine");
  });
});

// ---------------------------------------------------------------------------
// 3. 未認証 — 401
// ---------------------------------------------------------------------------

describe("3. 未認証アクセス — 401", () => {
  it("supabaseAuthMiddleware が 401 を返す場合 → 401", async () => {
    // Override auth middleware to block
    mockAuthMiddleware.mockImplementation((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: "Unauthorized" });
    });

    const res = await request(makeUnauthApp())
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 4. avg_judge_score — score=0 評価は含まれない (score>0フィルタ)
// ---------------------------------------------------------------------------

describe("4. avg_judge_score — score=0 評価除外", () => {
  it("avg_judge_score が null → null として返す", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total_sessions: "0" }] })
      .mockResolvedValueOnce({ rows: [{ prev_total_sessions: "0" }] })
      .mockResolvedValueOnce({ rows: [{ avg_judge_score: null }] }) // score>0フィルタ後 = null
      .mockResolvedValueOnce({ rows: [{ total_knowledge_gaps: "0" }] })
      .mockResolvedValueOnce({ rows: [{ avg_messages_per_session: "0" }] })
      .mockResolvedValueOnce({ rows: [{ avatar_session_count: "0" }] })
      .mockResolvedValueOnce({ rows: [] })   // sentiment
      .mockResolvedValueOnce({ rows: [] })   // Phase65-3: CV aggregation
      .mockResolvedValueOnce({ rows: [{ days: 10 }] }); // Phase65-3: tenant age

    const res = await request(makeApp())
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.avg_judge_score).toBeNull();
  });

  it("avg_judge_score クエリには AND score > 0 が含まれる", async () => {
    setupSummaryMocks();
    await request(makeApp()).get("/v1/admin/analytics/summary");

    // 3番目のクエリが avg_judge_score のクエリ
    const evalQuery = mockQuery.mock.calls[2]?.[0] as string;
    expect(evalQuery).toContain("score > 0");
  });
});

// ---------------------------------------------------------------------------
// 5. GET /v1/admin/analytics/evaluations — score>0フィルタ
// ---------------------------------------------------------------------------

describe("5. GET /v1/admin/analytics/evaluations — score>0フィルタ", () => {
  function setupEvalMocks() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ range: "40-60", count: "5" }, { range: "60-80", count: "8" }] })
      .mockResolvedValueOnce({
        rows: [{ psychology_fit: "70.0", customer_reaction: "65.0", stage_progress: "72.0", taboo_violation: "88.0" }],
      })
      .mockResolvedValueOnce({ rows: [] }); // low score sessions
  }

  it("score_distribution クエリに AND score > 0 が含まれる", async () => {
    setupEvalMocks();
    await request(makeApp()).get("/v1/admin/analytics/evaluations");

    const distQuery = mockQuery.mock.calls[0]?.[0] as string;
    expect(distQuery).toContain("score > 0");
  });

  it("5 バケット全て返す (欠損は 0 埋め)", async () => {
    setupEvalMocks();
    const res = await request(makeApp()).get("/v1/admin/analytics/evaluations");

    expect(res.status).toBe(200);
    expect(res.body.score_distribution).toHaveLength(5);
    const buckets = res.body.score_distribution.map((b: any) => b.range);
    expect(buckets).toEqual(["0-20", "20-40", "40-60", "60-80", "80-100"]);
  });
});
