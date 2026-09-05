// src/api/admin/tenants/shopifyDeletionQueueRoute.test.ts
// GET /v1/admin/shopify/deletion-queue の検証(D15/FR-16/§7 D-5)。
// 禁止50: 保留0件のときも「異常なし」ではなく total: 0 / pending: [] を返すことを固定する。

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

describe("GET /v1/admin/shopify/deletion-queue", () => {
  beforeEach(() => jest.clearAllMocks());

  it("client_admin は 403", async () => {
    const db = { query: jest.fn() };
    const app = makeApp(db, "client_admin");
    const res = await request(app).get("/v1/admin/shopify/deletion-queue");
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("保留0件のときは pending:[] / total:0 を返す(異常なしとは言わない)", async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }) };
    const app = makeApp(db);
    const res = await request(app).get("/v1/admin/shopify/deletion-queue");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.pending).toEqual([]);
  });

  it("期限内(残り2日以上)は severity:null で返す", async () => {
    const requestedAt = new Date(); // たった今 → 残り30日
    const db = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [{ id: "tenant-a", shopify_shop_domain: "a.myshopify.com", deletion_requested_at: requestedAt }],
        rowCount: 1,
      }),
    };
    const app = makeApp(db);
    const res = await request(app).get("/v1/admin/shopify/deletion-queue");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.pending[0]).toMatchObject({ tenantId: "tenant-a", shopDomain: "a.myshopify.com", severity: null });
  });

  it("期限超過(31日以上前)は severity:critical で返す", async () => {
    const requestedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const db = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [{ id: "tenant-b", shopify_shop_domain: "b.myshopify.com", deletion_requested_at: requestedAt }],
        rowCount: 1,
      }),
    };
    const app = makeApp(db);
    const res = await request(app).get("/v1/admin/shopify/deletion-queue");
    expect(res.status).toBe(200);
    expect(res.body.pending[0].severity).toBe("critical");
    expect(res.body.pending[0].daysUntilDeadline).toBeLessThan(0);
  });

  it("DB エラー時は 500", async () => {
    const db = { query: jest.fn().mockRejectedValueOnce(new Error("boom")) };
    const app = makeApp(db);
    const res = await request(app).get("/v1/admin/shopify/deletion-queue");
    expect(res.status).toBe(500);
  });
});
