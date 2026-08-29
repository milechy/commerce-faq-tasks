// src/api/admin/analytics/analyticsPlanGate.test.ts
// GID: LP料金表(Standard〜: 会話分析 / Growth〜: 成果分析(CV計測))に基づくplan制限の
// 回帰テスト。pool可用性チェックの後段でplanを確認し、client_adminのみ対象とすることを
// 検証する。2026-08-29: summary/trends/evaluations(analytics)を Standard へ開放し、
// conversions(conversion)は Growth のまま据え置いた分割の固定。

const mockQuery = jest.fn();

jest.mock("../../../lib/db", () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
  getPool: () => ({ query: (...args: any[]) => mockQuery(...args) }),
}));
jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../../lib/notifications", () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn(),
}));
jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

import express from "express";
import request from "supertest";
import { registerAnalyticsRoutes } from "./routes";

function makeApp(appMetadata: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = appMetadata ? { app_metadata: appMetadata } : null;
    next();
  });
  registerAnalyticsRoutes(app);
  return app;
}

describe("GET /v1/admin/analytics/summary — plan ゲート", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=starter → 403 plan_upgrade_required、以降のクエリは実行されない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [{ total: "0" }], rowCount: 0 }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).not.toBe(403);
  });

  it("super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)", async () => {
    mockQuery.mockResolvedValue({ rows: [{ total: "0" }], rowCount: 0 });

    const res = await request(makeApp({ role: "super_admin" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).not.toBe(403);
    // 1件目のクエリがplan確認(`SELECT plan FROM tenants`)ではないことを確認
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? "";
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });

  // 2026-08-29: analyticsをGrowthからStandardへ開放した本体。summaryはStandardで
  // 通ることを固定する(analyticsPlanGate回帰の中核)。
  it("client_admin + plan=standard → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [{ total: "0" }], rowCount: 0 }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/summary");

    expect(res.status).not.toBe(403);
  });
});

// conversions(成果分析)はanalytics分割後もGrowthのまま据え置き。summaryがStandardで
// 通るようになった一方、こちらはStandardでは403になることを固定する(混同防止の回帰)。
describe("GET /v1/admin/analytics/conversions — plan ゲート(Growthのまま据え置き)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=standard → 403 plan_upgrade_required(analyticsとは別ゲート)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.message).toContain("Growth");
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/conversions");

    expect(res.status).not.toBe(403);
  });
});

// [H-5] GID 1217969425230400: knowledge-attribution / rule-effect はplanゲートを
// 一切通っていなかった(free_ad含む全プランが無制限に取得可能)。性質としては成果分析
// (conversion, Growth〜)なのでconversionsと同じゲートを適用する回帰を固定する。
describe("GET /v1/admin/analytics/knowledge-attribution — plan ゲート", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=standard → 403 plan_upgrade_required(以降のクエリは実行されない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/knowledge-attribution");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.message).toContain("Growth");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // 以降の集計クエリ用の汎用フォールバック

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/knowledge-attribution");

    expect(res.status).not.toBe(403);
  });

  it("super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp({ role: "super_admin" }))
      .get("/v1/admin/analytics/knowledge-attribution?tenant_id=tenant-a");

    expect(res.status).not.toBe(403);
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? "";
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });
});

describe("GET /v1/admin/analytics/rule-effect/:ruleId — plan ゲート", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("client_admin + plan=standard → 403 plan_upgrade_required(ルール参照クエリは実行されない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] });

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/rule-effect/42");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.message).toContain("Growth");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("client_admin + plan=growth → planゲートを通過する(403にならない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "growth" }] }); // plan確認
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // fetchRuleMeta以降の汎用フォールバック(rule_not_found → 404)

    const res = await request(makeApp({ role: "client_admin", tenant_id: "tenant-a" }))
      .get("/v1/admin/analytics/rule-effect/42");

    expect(res.status).not.toBe(403);
  });

  it("super_adminはplanゲートをバイパスする(plan確認クエリが実行されない)", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp({ role: "super_admin" }))
      .get("/v1/admin/analytics/rule-effect/42");

    expect(res.status).not.toBe(403);
    const firstCallSql = mockQuery.mock.calls[0]?.[0] ?? "";
    expect(firstCallSql).not.toMatch(/SELECT plan FROM tenants/);
  });
});
