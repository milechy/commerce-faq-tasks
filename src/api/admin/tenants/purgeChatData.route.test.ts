// src/api/admin/tenants/purgeChatData.route.test.ts
// テナント退会消去 POST /v1/admin/tenants/:id/purge-chat-data の検証。

import express from "express";
import { request } from "../../../../tests/helpers/testServer";
import { registerTenantAdminRoutes } from "./routes";

jest.mock("../../../auth/supabaseClient", () => ({ supabaseAdmin: null }));
jest.mock("../../../lib/tenant-context", () => ({
  registerTenant: jest.fn(),
  updateTenantEnabled: jest.fn(),
  setTenantApiKeyExpiry: jest.fn(),
  revokeTenantApiKey: jest.fn(),
  addTenantApiKey: jest.fn().mockReturnValue(false),
  updateTenantAllowedOrigins: jest.fn(),
}));
jest.mock("../../../agent/openclaw/workspaceCache", () => ({ invalidateWorkspaceCache: jest.fn() }));
jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../chat-history/retentionRepository", () => ({
  purgeTenantChatData: jest.fn(),
}));

import { purgeTenantChatData } from "../chat-history/retentionRepository";
const mockPurge = purgeTenantChatData as jest.MockedFunction<typeof purgeTenantChatData>;

type Role = "super_admin" | "client_admin";
function makeApp(db: any, role: Role = "super_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { email: "admin@example.com", app_metadata: { tenant_id: tenantId, role } };
    next();
  });
  registerTenantAdminRoutes(app, db);
  return app;
}

describe("POST /v1/admin/tenants/:id/purge-chat-data", () => {
  beforeEach(() => jest.clearAllMocks());

  it("client_admin は 403", async () => {
    const db = { query: jest.fn() };
    const app = makeApp(db, "client_admin");
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/purge-chat-data")
      .send({ mode: "schedule", reason: "退会申請に伴う消去" });
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("存在しないテナントは 404", async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }) };
    const app = makeApp(db);
    const res = await request(app)
      .post("/v1/admin/tenants/nope/purge-chat-data")
      .send({ mode: "schedule", reason: "退会に伴う消去" });
    expect(res.status).toBe(404);
  });

  it("schedule: 予約時刻を設定し監査を記録する", async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "tenant-a" }], rowCount: 1 }) // 存在チェック
        .mockResolvedValueOnce({ rows: [{ chat_data_purge_requested_at: "2026-08-30T00:00:00.000Z" }], rowCount: 1 }) // UPDATE RETURNING
        .mockResolvedValue({ rows: [], rowCount: 1 }), // INSERT audit
    };
    const app = makeApp(db);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/purge-chat-data")
      .send({ mode: "schedule", reason: "退会に伴う消去" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("schedule");
    expect(res.body.chat_data_purge_requested_at).toBe("2026-08-30T00:00:00.000Z");
    const sqls = db.query.mock.calls.map((c: any[]) => c[0]);
    expect(sqls.some((s: string) => /UPDATE tenants SET chat_data_purge_requested_at = NOW/i.test(s))).toBe(true);
    expect(sqls.some((s: string) => /tenant_chat_data_purge_schedule/i.test(s))).toBe(true);
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("schedule: reason 不足は 400", async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: "tenant-a" }], rowCount: 1 }) };
    const app = makeApp(db);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/purge-chat-data")
      .send({ mode: "schedule", reason: "x" });
    expect(res.status).toBe(400);
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("immediate: confirm がテナントIDと不一致は 400", async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: "tenant-a" }], rowCount: 1 }) };
    const app = makeApp(db);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/purge-chat-data")
      .send({ mode: "immediate", confirm: "wrong", reason: "退会に伴う消去" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("confirm_mismatch");
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("immediate: confirm 一致で消去を実行する", async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: "tenant-a" }], rowCount: 1 }) };
    mockPurge.mockResolvedValueOnce({
      tenant_id: "tenant-a", sessions: 3, messages: 12, option_orders_nulled: 0, dryRun: false,
    });
    const app = makeApp(db);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/purge-chat-data")
      .send({ mode: "immediate", confirm: "tenant-a", reason: "退会に伴う消去" });
    expect(res.status).toBe(200);
    expect(res.body.purged.sessions).toBe(3);
    expect(mockPurge).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", reason: "退会に伴う消去" }));
  });

  it("cancel: 予約を解除する", async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "tenant-a" }], rowCount: 1 }) // 存在チェック
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    const app = makeApp(db);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/purge-chat-data")
      .send({ mode: "cancel" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("cancel");
    const sqls = db.query.mock.calls.map((c: any[]) => c[0]);
    expect(sqls.some((s: string) => /chat_data_purge_requested_at = NULL/i.test(s))).toBe(true);
  });
});
