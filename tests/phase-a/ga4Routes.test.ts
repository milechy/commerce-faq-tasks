// tests/phase-a/ga4Routes.test.ts
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { registerGa4TenantRoutes } from "../../src/api/admin/tenants/ga4Routes";

jest.mock("../../src/lib/ga4/ga4HealthCheck", () => ({
  runGa4HealthCheck: jest.fn(),
}));

import { runGa4HealthCheck } from "../../src/lib/ga4/ga4HealthCheck";
const mockHealthCheck = runGa4HealthCheck as jest.MockedFunction<typeof runGa4HealthCheck>;

const JWT_SECRET = "test-jwt-secret";

function makeToken(role: "super_admin" | "client_admin", tenantId: string) {
  return jwt.sign({ app_metadata: { role, tenant_id: tenantId } }, JWT_SECRET);
}

function makeApp(queryResponses: Array<{ rows: unknown[]; rowCount?: number } | Error>) {
  const app = express();
  app.use(express.json());
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = "production";

  let callCount = 0;
  const mockDb: any = {
    query: jest.fn().mockImplementation(() => {
      const resp = queryResponses[callCount++] ?? { rows: [], rowCount: 0 };
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp);
    }),
  };
  registerGa4TenantRoutes(app, mockDb);
  return { app, mockDb };
}

describe("POST /v1/admin/tenants/:id/ga4/connect", () => {
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.NODE_ENV;
  });

  it("saves property ID and returns pending status", async () => {
    const { app } = makeApp([
      { rows: [{ id: "tenant-a", ga4_property_id: "111", ga4_status: "pending", ga4_invited_at: new Date() }], rowCount: 1 },
      { rows: [], rowCount: 1 }, // log insert
    ]);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/ga4/connect")
      .set("Authorization", `Bearer ${makeToken("super_admin", "tenant-a")}`)
      .send({ property_id: "111" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenant.ga4_status).toBe("pending");
  });

  it("rejects invalid property_id (non-numeric)", async () => {
    const { app } = makeApp([]);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/ga4/connect")
      .set("Authorization", `Bearer ${makeToken("super_admin", "tenant-a")}`)
      .send({ property_id: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("returns 403 for wrong tenant client_admin", async () => {
    const { app } = makeApp([]);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-b/ga4/connect")
      .set("Authorization", `Bearer ${makeToken("client_admin", "tenant-a")}`)
      .send({ property_id: "111" });
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/admin/tenants/:id/ga4/test", () => {
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.NODE_ENV;
    mockHealthCheck.mockClear();
  });

  it("returns ok:true when health check passes", async () => {
    mockHealthCheck.mockResolvedValue({ status: "connected", connectedAt: new Date() });
    const { app } = makeApp([
      { rows: [{ ga4_property_id: "111" }], rowCount: 1 },
    ]);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/ga4/test")
      .set("Authorization", `Bearer ${makeToken("super_admin", "tenant-a")}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.status).toBe("connected");
  });

  it("returns ok:false when health check fails", async () => {
    mockHealthCheck.mockResolvedValue({ status: "error", errorMessage: "permission_denied" });
    const { app } = makeApp([
      { rows: [{ ga4_property_id: "111" }], rowCount: 1 },
    ]);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/ga4/test")
      .set("Authorization", `Bearer ${makeToken("super_admin", "tenant-a")}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });

  it("returns 400 when no property_id is set", async () => {
    const { app } = makeApp([
      { rows: [{ ga4_property_id: null }], rowCount: 1 },
    ]);
    const res = await request(app)
      .post("/v1/admin/tenants/tenant-a/ga4/test")
      .set("Authorization", `Bearer ${makeToken("super_admin", "tenant-a")}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/tenants/:id/ga4/status", () => {
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.NODE_ENV;
  });

  it("returns GA4 status with recent tests", async () => {
    const { app } = makeApp([
      {
        rows: [{
          ga4_property_id: "111", ga4_status: "connected",
          ga4_invited_at: null, ga4_connected_at: new Date(),
          ga4_last_sync_at: new Date(), ga4_error_message: null,
          tenant_contact_email: "test@example.com",
        }],
        rowCount: 1,
      },
      { rows: [{ test_type: "measurement_protocol", success: true, error_message: null, tested_at: new Date() }], rowCount: 1 },
    ]);
    const res = await request(app)
      .get("/v1/admin/tenants/tenant-a/ga4/status")
      .set("Authorization", `Bearer ${makeToken("super_admin", "tenant-a")}`);
    expect(res.status).toBe(200);
    expect(res.body.ga4_status).toBe("connected");
    expect(res.body.recent_tests).toHaveLength(1);
  });
});

describe("DELETE /v1/admin/tenants/:id/ga4/disconnect", () => {
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.NODE_ENV;
  });

  it("disconnects GA4 and returns ok", async () => {
    const { app } = makeApp([
      { rows: [{ id: "tenant-a" }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const res = await request(app)
      .delete("/v1/admin/tenants/tenant-a/ga4/disconnect")
      .set("Authorization", `Bearer ${makeToken("super_admin", "tenant-a")}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
