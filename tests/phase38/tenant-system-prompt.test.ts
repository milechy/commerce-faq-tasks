// tests/phase38/tenant-system-prompt.test.ts
// Phase38: テナントシステムプロンプト — モックExpressアプリを使ったユニットテスト

import express from "express";
import request from "supertest";
import { registerTenantAdminRoutes } from "../../src/api/admin/tenants/routes";

jest.mock("../../src/lib/tenant-context", () => ({ registerTenant: jest.fn() }));
jest.mock("../../src/auth/supabaseClient", () => ({ supabaseAdmin: null }));

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const SUPER_ADMIN_TOKEN = makeDevJwt({
  app_metadata: { role: "super_admin", tenant_id: "demo-tenant" },
});

const FULL_TENANT_ROW = {
  id: "demo-tenant",
  name: "デモテナント",
  plan: "starter",
  is_active: true,
  allowed_origins: [],
  system_prompt: "デフォルトのシステムプロンプト",
  billing_enabled: false,
  billing_free_from: null,
  billing_free_until: null,
  features: { avatar: false, voice: false, rag: true },
  lemonslice_agent_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("Tenant System Prompt API", () => {
  let app: express.Application;
  let mockDb: any;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    mockDb = { query: jest.fn() };
    registerTenantAdminRoutes(app, mockDb);
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/tenants/:id
  // -------------------------------------------------------------------------
  describe("GET /v1/admin/tenants/:id", () => {
    it("returns 200 and tenant with system_prompt field", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [FULL_TENANT_ROW],
        rowCount: 1,
      });

      const res = await request(app)
        .get("/v1/admin/tenants/demo-tenant")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("system_prompt");
    });

    it("returns 404 when tenant not found (rowCount=0)", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const res = await request(app)
        .get("/v1/admin/tenants/nonexistent-tenant")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/admin/tenants/:id
  // -------------------------------------------------------------------------
  describe("PATCH /v1/admin/tenants/:id", () => {
    it("updates system_prompt and returns 200 with updated tenant", async () => {
      const newPrompt = "新しいシステムプロンプト";
      mockDb.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "demo-tenant" }] }) // existence check
        .mockResolvedValueOnce({ rows: [{ ...FULL_TENANT_ROW, system_prompt: newPrompt }] }); // update

      const res = await request(app)
        .patch("/v1/admin/tenants/demo-tenant")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ system_prompt: newPrompt });

      expect(res.status).toBe(200);
      expect(res.body.system_prompt).toBe(newPrompt);
    });

    it('clears system_prompt with empty string "" and returns 200', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "demo-tenant" }] }) // existence check
        .mockResolvedValueOnce({ rows: [{ ...FULL_TENANT_ROW, system_prompt: "" }] }); // update

      const res = await request(app)
        .patch("/v1/admin/tenants/demo-tenant")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ system_prompt: "" });

      expect(res.status).toBe(200);
    });
  });
});
