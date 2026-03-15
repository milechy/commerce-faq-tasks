import express from "express";
import request from "supertest";
import { registerTenantAdminRoutes } from "../../../../src/api/admin/tenants/routes";
import { generateApiKey, hashApiKey, maskApiKey, maskApiKeyPrefix } from "../../../../src/api/admin/tenants/apiKeyUtils";

// tenant-context をモック
jest.mock("../../../../src/lib/tenant-context", () => ({
  registerTenant: jest.fn(),
}));

// supabaseClient をモック（招待API用 — テストでは不要）
jest.mock("../../../../src/auth/supabaseClient", () => ({
  supabaseAdmin: null,
}));

/**
 * 開発モード用フェイクJWT（署名検証なし）
 * tenantAuth は NODE_ENV=development のとき jwt.decode() のみ実行するため、
 * 署名は任意の文字列で問題ない。
 */
function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const SUPER_ADMIN_TOKEN = makeDevJwt({
  sub: "admin-user-id",
  app_metadata: { role: "super_admin" },
});

describe("Tenant Admin Routes", () => {
  let app: express.Application;
  let mockDb: any;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockDb = {
      query: jest.fn(),
    };

    registerTenantAdminRoutes(app, mockDb);
  });

  describe("GET /v1/admin/tenants", () => {
    it("returns tenant list", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "tenant1", name: "Test", plan: "starter", is_active: true, created_at: new Date(), updated_at: new Date() }],
      });
      const res = await request(app)
        .get("/v1/admin/tenants")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.tenants).toHaveLength(1);
    });
  });

  describe("POST /v1/admin/tenants", () => {
    it("creates a tenant", async () => {
      const newTenant = { id: "test-tenant", name: "テストテナント", plan: "starter", is_active: true, created_at: new Date(), updated_at: new Date() };
      mockDb.query.mockResolvedValueOnce({ rows: [newTenant], rowCount: 1 });
      const res = await request(app)
        .post("/v1/admin/tenants")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ id: "test-tenant", name: "テストテナント", plan: "starter" });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe("test-tenant");
    });

    it("rejects invalid tenant id", async () => {
      const res = await request(app)
        .post("/v1/admin/tenants")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ id: "Invalid ID!", name: "Test" });
      expect(res.status).toBe(400);
    });

    it("returns 409 on duplicate id", async () => {
      mockDb.query.mockRejectedValueOnce({ code: "23505" });
      const res = await request(app)
        .post("/v1/admin/tenants")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
        .send({ id: "dup-tenant", name: "重複テナント" });
      expect(res.status).toBe(409);
    });
  });

  describe("POST /v1/admin/tenants/:id/keys", () => {
    it("issues an API key starting with rjc_", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: "t1", name: "T1", plan: "starter", is_active: true }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: "key-uuid", tenant_id: "t1", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date(), expires_at: null }],
          rowCount: 1,
        });
      const res = await request(app)
        .post("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(201);
      expect(res.body.api_key).toMatch(/^rjc_/);
      expect(res.body.tenant_id).toBe("t1");
    });
  });

  describe("GET /v1/admin/tenants/:id/keys", () => {
    it("returns masked keys", async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: "t1" }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: "k1", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date(), expires_at: null, last_used_at: null }],
        });
      const res = await request(app)
        .get("/v1/admin/tenants/t1/keys")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.keys[0].prefix).toMatch(/\*\*\*\*$/);
    });
  });

  describe("DELETE /v1/admin/tenants/:id/keys/:keyId", () => {
    it("deactivates a key", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: "k1", tenant_id: "t1", is_active: false }], rowCount: 1 });
      const res = await request(app)
        .delete("/v1/admin/tenants/t1/keys/k1")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("returns 404 for non-existent key", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const res = await request(app)
        .delete("/v1/admin/tenants/t1/keys/no-key")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
    });
  });
});

describe("apiKeyUtils", () => {
  it("generateApiKey starts with rjc_", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^rjc_[a-f0-9]{64}$/);
  });

  it("hashApiKey returns 64 char hex", () => {
    const hash = hashApiKey("rjc_test");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maskApiKey masks after 12 chars", () => {
    const masked = maskApiKey("rjc_abcd1234xyz");
    expect(masked).toBe("rjc_abcd1234****");
  });

  it("maskApiKeyPrefix appends ****", () => {
    const masked = maskApiKeyPrefix("rjc_abcd1234");
    expect(masked).toBe("rjc_abcd1234****");
  });
});
