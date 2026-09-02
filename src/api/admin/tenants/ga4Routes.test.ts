// src/api/admin/tenants/ga4Routes.test.ts
// GID [A2A-0d]: 外部アナリティクス連携(GA4)はGrowthプラン以上限定。
// connect/test はプラン未達なら403 plan_upgrade_requiredで弾かれ、
// status(状態確認)は隠すのではなく常時読めることを回帰で確認する。

import express from "express";
import type { Express } from "express";
import { request } from "../../../../tests/helpers/testServer";
import type { Pool } from "pg";
import { registerGa4TenantRoutes } from "./ga4Routes";

jest.mock("../../../lib/ga4/ga4HealthCheck", () => ({
  runGa4HealthCheck: jest.fn().mockResolvedValue({ status: "connected", errorMessage: null }),
}));

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const CLIENT_ADMIN_TOKEN = makeDevJwt({ app_metadata: { role: "client_admin", tenant_id: "carnation" } });

const mockQuery = jest.fn();
const db = { query: (...args: unknown[]) => mockQuery(...args) } as unknown as Pool;

let app: Express;

beforeAll(() => {
  process.env.NODE_ENV = "development";
  process.env.ALLOW_INSECURE_DEV_AUTH = "1";
});

beforeEach(() => {
  mockQuery.mockReset();
  app = express();
  app.use(express.json());
  registerGa4TenantRoutes(app, db);
});

describe("POST /v1/admin/tenants/:id/ga4/connect (plan gate)", () => {
  it("403 plan_upgrade_required を返す(plan=standard、GA4 UPDATEは実行しない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] }); // queryTenantPlan

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/ga4/connect")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ property_id: "123456789" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    // plan lookup の1回だけで、UPDATE/INSERTは呼ばれない
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("plan=growth なら通過して保存する", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: "growth" }] }) // queryTenantPlan
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "carnation", ga4_property_id: "123456789", ga4_status: "pending", ga4_invited_at: null }],
      }) // UPDATE tenants
      .mockResolvedValueOnce({ rows: [] }); // INSERT ga4_connection_logs

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/ga4/connect")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ property_id: "123456789" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("POST /v1/admin/tenants/:id/ga4/test (plan gate)", () => {
  it("403 plan_upgrade_required を返す(plan=starter、GA4 APIは呼ばない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "starter" }] }); // queryTenantPlan

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/ga4/test")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("GET /v1/admin/tenants/:id/ga4/status (プラン制限しない)", () => {
  it("plan未達でも常に読める(隠すのではなくロック表示にする方針。connect/testと違い403にしない)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          ga4_property_id: null, ga4_status: "not_configured", ga4_invited_at: null,
          ga4_connected_at: null, ga4_last_sync_at: null, ga4_error_message: null,
          tenant_contact_email: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // recent_tests

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/ga4/status")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });
});
