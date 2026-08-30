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
  // [H-7] client_adminはplanゲート(conversion=Growth〜)を通す必要がある。
  // super_adminはバイパスされるため影響しない。
  plan?: string;
}) {
  let call = 0;
  const plan = rows.plan ?? "growth";
  return {
    query: jest.fn().mockImplementation((sql: string) => {
      // queryTenantPlanOrThrow(`SELECT plan FROM tenants ...`)は本体クエリの
      // 呼び出し順(0〜4番目)には数えず、SQLで判別して別枠で答える。
      if (/SELECT\s+plan\s+FROM\s+tenants/i.test(sql)) {
        return Promise.resolve({ rows: [{ plan }] });
      }
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
  process.env.ALLOW_INSECURE_DEV_AUTH = "1"; // [P1] dev-decode opt-in（署名検証スキップ）
  registerAnalyticsSummaryRoutes(app, db);
  return app;
}

function makeToken(tenantId: string) {
  return jwt.sign({ app_metadata: { tenant_id: tenantId, role: "client_admin" } }, "test");
}

describe("GET /v1/admin/tenants/:id/analytics-summary", () => {
  afterEach(() => { delete process.env.NODE_ENV; delete process.env.ALLOW_INSECURE_DEV_AUTH; });

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

  // [H-7] GID 1217969364194602: DBが完全に落ちている場合、plan確認クエリ自体も
  // 失敗する。queryTenantPlanOrThrow(queryTenantPlanではない)を使うことで、
  // この失敗がfree_adへ丸め込まれて403(plan_upgrade_required)に化けず、
  // 実際のDB障害として500で返ることを固定する回帰テスト。
  it("returns 500 on DB error (plan確認クエリも含めて全滅している場合、403に化けない)", async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error("db error")) } as any;
    const app = makeApp(db);
    const res = await request(app)
      .get("/v1/admin/tenants/t1/analytics-summary")
      .set("Authorization", `Bearer ${makeToken("t1")}`);
    expect(res.status).toBe(500);
    expect(res.body.error).not.toBe("plan_upgrade_required");
  });

  // [H-7] GID 1217969364194602: このタブが返すCV内訳・rank分布・source不一致アラートは
  // routes.ts の /v1/admin/analytics/conversions と同じ「成果分析」の性質なのに
  // plan制限が無かった。conversion(Growth〜)ゲートの回帰テスト。
  describe("plan ゲート", () => {
    it("client_admin + plan=starter → 403 plan_upgrade_required", async () => {
      const db = makeMockDb({ plan: "starter" });
      const app = makeApp(db);
      const res = await request(app)
        .get("/v1/admin/tenants/t1/analytics-summary")
        .set("Authorization", `Bearer ${makeToken("t1")}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("plan_upgrade_required");
    });

    it("client_admin + plan=growth → planゲートを通過する(既定値。200)", async () => {
      const db = makeMockDb({});
      const app = makeApp(db);
      const res = await request(app)
        .get("/v1/admin/tenants/t1/analytics-summary")
        .set("Authorization", `Bearer ${makeToken("t1")}`);
      expect(res.status).toBe(200);
    });

    it("super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)", async () => {
      const db = makeMockDb({});
      const app = makeApp(db);
      const token = jwt.sign({ app_metadata: { role: "super_admin" } }, "test");
      const res = await request(app)
        .get("/v1/admin/tenants/any-tenant/analytics-summary")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const firstCallSql = db.query.mock.calls[0]?.[0] ?? "";
      expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
    });
  });
});
