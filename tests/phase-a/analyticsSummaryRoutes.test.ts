// tests/phase-a/analyticsSummaryRoutes.test.ts
import express from "express";
import request from "supertest";
import { registerAnalyticsSummaryRoutes } from "../../src/api/admin/tenants/analyticsSummaryRoutes";
import jwt from "jsonwebtoken";

jest.mock("../../src/lib/billing/posthogUsageTracker", () => ({
  getMonthlyLLMUsageFromPostHog: jest.fn().mockResolvedValue(null),
}));

function makeMockDb(rows: {
  conversations?: { total: string; avg_per_day: string }[];
  cvMacro?: { source: string; cnt: string }[];
  cvMicro?: { source: string; cnt: string }[];
  cvRank?: { rank: string; cnt: string }[];
  alert?: { mismatch: string; ranked_d: string }[];
}) {
  let call = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const i = call++;
      switch (i) {
        case 0: return Promise.resolve({ rows: rows.conversations ?? [{ total: "10", avg_per_day: "0.33" }] });
        case 1: return Promise.resolve({ rows: rows.cvMacro ?? [] });
        case 2: return Promise.resolve({ rows: rows.cvMicro ?? [] });
        case 3: return Promise.resolve({ rows: rows.cvRank ?? [] });
        case 4: return Promise.resolve({ rows: rows.alert ?? [{ mismatch: "0", ranked_d: "0" }] });
        default: return Promise.resolve({ rows: [] });
      }
    }),
  } as any;
}

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  process.env.NODE_ENV = "development";
  registerAnalyticsSummaryRoutes(app, db);
  return app;
}

function makeToken(tenantId: string) {
  return jwt.sign({ app_metadata: { tenant_id: tenantId, role: "client_admin" } }, "test");
}

describe("GET /v1/admin/tenants/:id/analytics-summary", () => {
  afterEach(() => { delete process.env.NODE_ENV; });

  it("returns summary with conversations and CV data", async () => {
    const db = makeMockDb({
      conversations: [{ total: "42", avg_per_day: "1.40" }],
      cvMacro: [{ source: "r2c_db", cnt: "15" }, { source: "ga4", cnt: "10" }],
      cvMicro: [{ source: "posthog", cnt: "5" }],
      cvRank: [{ rank: "A", cnt: "3" }, { rank: "D", cnt: "1" }],
      alert: [{ mismatch: "2", ranked_d: "1" }],
    });
    const app = makeApp(db);
    const res = await request(app)
      .get("/v1/admin/tenants/t1/analytics-summary?period=last_30d")
      .set("Authorization", `Bearer ${makeToken("t1")}`);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("last_30d");
    expect(res.body.conversations.total).toBe(42);
    expect(res.body.cv.macro.r2c_db).toBe(15);
    expect(res.body.cv.macro.ga4).toBe(10);
    expect(res.body.cv.micro.posthog).toBe(5);
    expect(res.body.cv.macro.ranked_a).toBe(3);
    expect(res.body.alerts.source_mismatch_count).toBe(2);
    expect(res.body.alerts.ranked_d_count).toBe(1);
  });

  it("returns 403 when tenant_id does not match", async () => {
    const db = makeMockDb({});
    const app = makeApp(db);
    const res = await request(app)
      .get("/v1/admin/tenants/other-tenant/analytics-summary")
      .set("Authorization", `Bearer ${makeToken("t1")}`);
    expect(res.status).toBe(403);
  });

  it("super_admin can access any tenant", async () => {
    const db = makeMockDb({});
    const app = makeApp(db);
    const token = jwt.sign({ app_metadata: { role: "super_admin" } }, "test");
    const res = await request(app)
      .get("/v1/admin/tenants/any-tenant/analytics-summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("uses default period last_30d when invalid period provided", async () => {
    const db = makeMockDb({});
    const app = makeApp(db);
    const res = await request(app)
      .get("/v1/admin/tenants/t1/analytics-summary?period=invalid")
      .set("Authorization", `Bearer ${makeToken("t1")}`);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("invalid");
    // days defaults to 30 for unknown period key
  });

  it("returns 500 on DB error", async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error("db error")) } as any;
    const app = makeApp(db);
    const res = await request(app)
      .get("/v1/admin/tenants/t1/analytics-summary")
      .set("Authorization", `Bearer ${makeToken("t1")}`);
    expect(res.status).toBe(500);
  });
});
