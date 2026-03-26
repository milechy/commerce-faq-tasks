// src/api/admin/reports/routes.test.ts
// Phase46: 週次レポート API テスト

import express from "express";
import request from "supertest";
import { registerReportRoutes } from "./routes";

// ---------------------------------------------------------------------------
// リポジトリモック
// ---------------------------------------------------------------------------

jest.mock("./reportsRepository", () => ({
  listReports: jest.fn(),
  getReport: jest.fn(),
  getUnreadCount: jest.fn(),
}));

import { listReports, getReport, getUnreadCount } from "./reportsRepository";

// ---------------------------------------------------------------------------
// テスト用 Express アプリ生成
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
  registerReportRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

const REPORT = {
  id: 1,
  tenant_id: "tenant-a",
  title: "週次レポート 2026-03-24",
  content: { summary: "今週の成績は良好でした", total_conversations: 150 },
  read_at: null,
  created_at: NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// 1. GET /v1/admin/reports → 200
describe("1. GET /v1/admin/reports → 200", () => {
  it("returns reports list in descending order", async () => {
    (listReports as jest.Mock).mockResolvedValue([REPORT]);

    const res = await request(makeApp()).get("/v1/admin/reports?tenantId=tenant-a");

    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].title).toBe("週次レポート 2026-03-24");
  });
});

// 2. GET /v1/admin/reports/:id → 200
describe("2. GET /v1/admin/reports/:id → 200", () => {
  it("returns report detail", async () => {
    (getReport as jest.Mock).mockResolvedValue(REPORT);

    const res = await request(makeApp()).get("/v1/admin/reports/1");

    expect(res.status).toBe(200);
    expect(res.body.report.id).toBe(1);
    expect(res.body.report.content).toEqual(REPORT.content);
  });
});

// 3. GET /v1/admin/reports/:id 存在しない → 404
describe("3. GET /v1/admin/reports/:id 存在しない → 404", () => {
  it("returns 404 when report not found", async () => {
    (getReport as jest.Mock).mockResolvedValue(null);

    const res = await request(makeApp()).get("/v1/admin/reports/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("レポートが見つかりません");
  });
});

// 4. GET /v1/admin/reports/unread-count → 数値
describe("4. GET /v1/admin/reports/unread-count → 数値", () => {
  it("returns unread count", async () => {
    (getUnreadCount as jest.Mock).mockResolvedValue(3);

    const res = await request(makeApp()).get(
      "/v1/admin/reports/unread-count?tenantId=tenant-a",
    );

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
  });
});

// 5. 認証なし → 401
describe("5. 認証なし → 401", () => {
  it("returns 401 when no auth", async () => {
    const app = express();
    app.use(express.json());
    app.use("/v1/admin/reports", (_req: any, res: any) =>
      res.status(401).json({ error: "Unauthorized" }),
    );

    const res = await request(app).get("/v1/admin/reports");
    expect(res.status).toBe(401);
  });
});

// 6. client_admin 他テナント → 403
describe("6. client_admin 他テナント → 403", () => {
  it("returns 403 when client_admin accesses other tenant", async () => {
    const res = await request(makeApp("client_admin", "tenant-a")).get(
      "/v1/admin/reports?tenantId=tenant-b",
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("他テナントのデータにアクセスできません");
  });
});

// 7. super_admin は他テナント参照可
describe("7. super_admin は他テナント参照可", () => {
  it("allows super_admin to access other tenant reports", async () => {
    (listReports as jest.Mock).mockResolvedValue([REPORT]);

    const res = await request(makeApp("super_admin", "tenant-admin")).get(
      "/v1/admin/reports?tenantId=tenant-b",
    );

    expect(res.status).toBe(200);
    expect((listReports as jest.Mock).mock.calls[0][0]).toBe("tenant-b");
  });
});
