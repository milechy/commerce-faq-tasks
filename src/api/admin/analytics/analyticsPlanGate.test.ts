// src/api/admin/analytics/analyticsPlanGate.test.ts
// GID: LP料金表(Growth〜: 高度なAnalytics)に基づくplan制限の回帰テスト。
// pool可用性チェックの後段でplanを確認し、client_adminのみ対象とすることを検証する。

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
});
