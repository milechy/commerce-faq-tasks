// src/api/admin/tenants/posthogRoutes.test.ts
// GID [A2A-0d]: 外部アナリティクス連携(PostHog)はGrowthプラン以上限定。
// ga4Routes.test.ts と揃え、connect/verify のプランゲートだけを確認する。

import express from "express";
import type { Express } from "express";
import { request } from "../../../../tests/helpers/testServer";
import type { Pool } from "pg";
import { registerPostHogTenantRoutes } from "./posthogRoutes";

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
  registerPostHogTenantRoutes(app, db);
});

describe("POST /v1/admin/tenants/:id/posthog/connect (plan gate)", () => {
  it("403 plan_upgrade_required を返す(plan=standard、UPDATEは実行しない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] }); // queryTenantPlan

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/posthog/connect")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ project_api_key: "phc_test_key" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("plan=enterprise なら通過して保存する", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: "enterprise" }] }) // queryTenantPlan
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "carnation" }] }); // UPDATE tenants

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/posthog/connect")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ project_api_key: "phc_test_key" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("GET /v1/admin/tenants/:id/posthog/status (プラン制限しない)", () => {
  it("plan未達でも常に読める", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ posthog_project_api_key_encrypted: null }] });

    const res = await request(app)
      .get("/v1/admin/tenants/carnation/posthog/status")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });
});
