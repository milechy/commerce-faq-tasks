// tests/phase50/analytics.test.ts
// Phase50 Stream A: Analytics集計API tests

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock the DB pool
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();

jest.mock("../../src/lib/db", () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
  },
}));

// Mock supabaseAuthMiddleware (bypass auth)
jest.mock("../../src/admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. GET /v1/admin/analytics/summary
// ---------------------------------------------------------------------------

describe("1. GET /v1/admin/analytics/summary", () => {
  function setupSummaryMocks(overrides: Partial<{
    total_sessions: string;
    prev_total_sessions: string;
    avg_judge_score: string | null;
    total_knowledge_gaps: string;
    avg_messages_per_session: string;
    avatar_session_count: string;
  }> = {}) {
    const defaults = {
      total_sessions: "10",
      prev_total_sessions: "8",
      avg_judge_score: "72.5",
      total_knowledge_gaps: "3",
      avg_messages_per_session: "4.2",
      avatar_session_count: "2",
    };
    const vals = { ...defaults, ...overrides };

    mockQuery
      .mockResolvedValueOnce({ rows: [{ total_sessions: vals.total_sessions }] })
      .mockResolvedValueOnce({ rows: [{ prev_total_sessions: vals.prev_total_sessions }] })
      .mockResolvedValueOnce({ rows: [{ avg_judge_score: vals.avg_judge_score }] })
      .mockResolvedValueOnce({ rows: [{ total_knowledge_gaps: vals.total_knowledge_gaps }] })
      .mockResolvedValueOnce({ rows: [{ avg_messages_per_session: vals.avg_messages_per_session }] })
      .mockResolvedValueOnce({ rows: [{ avatar_session_count: vals.avatar_session_count }] })
      .mockResolvedValueOnce({ rows: [] }); // sentiment distribution (Phase51)
  }

  it("returns correct shape for client_admin", async () => {
    setupSummaryMocks();
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/summary?period=30d");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      period: "30d",
      tenant_id: "tenant-a",
      total_sessions: 10,
      avg_judge_score: 72.5,
      total_knowledge_gaps: 3,
      avatar_session_count: 2,
      prev_total_sessions: 8,
    });
    expect(typeof res.body.avatar_rate).toBe("number");
    expect(typeof res.body.sessions_change_pct).toBe("number");
  });

  it("uses default period=30d when not specified", async () => {
    setupSummaryMocks();
    const res = await request(makeApp())
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.period).toBe("30d");
  });

  it("supports period=7d", async () => {
    setupSummaryMocks();
    const res = await request(makeApp())
      .get("/v1/admin/analytics/summary?period=7d");

    expect(res.status).toBe(200);
    expect(res.body.period).toBe("7d");
  });

  it("returns null avg_judge_score when no evaluations", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total_sessions: "0" }] })
      .mockResolvedValueOnce({ rows: [{ prev_total_sessions: "0" }] })
      .mockResolvedValueOnce({ rows: [{ avg_judge_score: null }] })
      .mockResolvedValueOnce({ rows: [{ total_knowledge_gaps: "0" }] })
      .mockResolvedValueOnce({ rows: [{ avg_messages_per_session: "0" }] })
      .mockResolvedValueOnce({ rows: [{ avatar_session_count: "0" }] })
      .mockResolvedValueOnce({ rows: [] }); // sentiment distribution (Phase51)

    const res = await request(makeApp())
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.avg_judge_score).toBeNull();
    expect(res.body.avatar_rate).toBe(0);
  });

  it("super_admin can query without tenant filter", async () => {
    setupSummaryMocks();
    const res = await request(makeApp("super_admin"))
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBeNull();
  });

  it("super_admin can filter by specific tenant", async () => {
    setupSummaryMocks();
    const res = await request(makeApp("super_admin"))
      .get("/v1/admin/analytics/summary?tenant=tenant-x");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe("tenant-x");
  });

  it("client_admin always uses own tenant_id", async () => {
    setupSummaryMocks();
    // Even if client_admin tries to pass ?tenant=other-tenant, it is ignored
    const res = await request(makeApp("client_admin", "tenant-a"))
      .get("/v1/admin/analytics/summary?tenant=other-tenant");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe("tenant-a");
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(makeApp())
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. GET /v1/admin/analytics/trends
// ---------------------------------------------------------------------------

describe("2. GET /v1/admin/analytics/trends", () => {
  const DAILY_ROWS = [
    { date: "2026-03-01", sessions: 5, avg_score: "68.0", knowledge_gaps: 1 },
    { date: "2026-03-02", sessions: 8, avg_score: null, knowledge_gaps: 0 },
    { date: "2026-03-03", sessions: 3, avg_score: "75.5", knowledge_gaps: 2 },
  ];

  it("returns daily array with correct shape", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: DAILY_ROWS })
      .mockResolvedValueOnce({ rows: [] }); // sentiment trends (Phase51)

    const res = await request(makeApp())
      .get("/v1/admin/analytics/trends?period=30d");

    expect(res.status).toBe(200);
    expect(res.body.period).toBe("30d");
    expect(res.body.tenant_id).toBe("tenant-a");
    expect(Array.isArray(res.body.daily)).toBe(true);
    expect(res.body.daily).toHaveLength(3);

    const first = res.body.daily[0];
    expect(first).toHaveProperty("date");
    expect(first).toHaveProperty("sessions");
    expect(first).toHaveProperty("avg_score");
    expect(first).toHaveProperty("knowledge_gaps");
  });

  it("avg_score is null when no evaluations for that day", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: DAILY_ROWS })
      .mockResolvedValueOnce({ rows: [] }); // sentiment trends (Phase51)

    const res = await request(makeApp())
      .get("/v1/admin/analytics/trends");

    expect(res.status).toBe(200);
    expect(res.body.daily[1].avg_score).toBeNull();
  });

  it("returns empty daily array when no data", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // sentiment trends (Phase51)

    const res = await request(makeApp())
      .get("/v1/admin/analytics/trends");

    expect(res.status).toBe(200);
    expect(res.body.daily).toEqual([]);
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(makeApp())
      .get("/v1/admin/analytics/trends");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 3. GET /v1/admin/analytics/evaluations
// ---------------------------------------------------------------------------

describe("3. GET /v1/admin/analytics/evaluations", () => {
  function setupEvalMocks() {
    // score distribution rows
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { range: "0-20", count: "1" },
          { range: "20-40", count: "3" },
          { range: "60-80", count: "5" },
        ],
      })
      // axis averages
      .mockResolvedValueOnce({
        rows: [{
          psychology_fit: "65.0",
          customer_reaction: "70.0",
          stage_progress: "55.0",
          taboo_violation: "90.0",
        }],
      })
      // low score sessions
      .mockResolvedValueOnce({
        rows: [
          {
            session_id: "sess-001",
            score: "25",
            evaluated_at: "2026-03-10T10:00:00.000Z",
            message_count: 6,
            feedback_summary: "Poor performance",
          },
        ],
      });
  }

  it("returns score_distribution with all 5 buckets", async () => {
    setupEvalMocks();

    const res = await request(makeApp())
      .get("/v1/admin/analytics/evaluations?period=30d");

    expect(res.status).toBe(200);
    expect(res.body.score_distribution).toHaveLength(5);

    const ranges = res.body.score_distribution.map((b: any) => b.range);
    expect(ranges).toEqual(["0-20", "20-40", "40-60", "60-80", "80-100"]);

    // Missing buckets filled with 0
    const fortyToSixty = res.body.score_distribution.find((b: any) => b.range === "40-60");
    expect(fortyToSixty.count).toBe(0);
    const eightyToHundred = res.body.score_distribution.find((b: any) => b.range === "80-100");
    expect(eightyToHundred.count).toBe(0);
  });

  it("returns axis_averages with all 4 axes", async () => {
    setupEvalMocks();

    const res = await request(makeApp())
      .get("/v1/admin/analytics/evaluations");

    expect(res.status).toBe(200);
    expect(res.body.axis_averages).toMatchObject({
      psychology_fit: 65,
      customer_reaction: 70,
      stage_progress: 55,
      taboo_violation: 90,
    });
  });

  it("returns low_score_sessions with correct shape", async () => {
    setupEvalMocks();

    const res = await request(makeApp())
      .get("/v1/admin/analytics/evaluations");

    expect(res.status).toBe(200);
    expect(res.body.low_score_sessions).toHaveLength(1);
    const session = res.body.low_score_sessions[0];
    expect(session).toMatchObject({
      session_id: "sess-001",
      score: 25,
      message_count: 6,
      feedback_summary: "Poor performance",
    });
    expect(typeof session.evaluated_at).toBe("string");
  });

  it("RBAC: client_admin is forced to own tenant_id", async () => {
    setupEvalMocks();

    const res = await request(makeApp("client_admin", "tenant-b"))
      .get("/v1/admin/analytics/evaluations?tenant=other-tenant");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe("tenant-b");
  });

  it("RBAC: super_admin can query other tenants", async () => {
    setupEvalMocks();

    const res = await request(makeApp("super_admin"))
      .get("/v1/admin/analytics/evaluations?tenant=tenant-c");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe("tenant-c");
  });

  it("returns 500 on DB error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(makeApp())
      .get("/v1/admin/analytics/evaluations");

    expect(res.status).toBe(500);
  });
});
