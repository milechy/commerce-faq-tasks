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

import { runGa4HealthCheck } from "../../../lib/ga4/ga4HealthCheck";
const mockedRunGa4HealthCheck = runGa4HealthCheck as jest.MockedFunction<typeof runGa4HealthCheck>;

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
  mockedRunGa4HealthCheck.mockClear();
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
    // ★ゲートが外部API呼び出し(GA4 Data API)の手前にあることの確認★
    expect(mockedRunGa4HealthCheck).not.toHaveBeenCalled();
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

// [A2A-0d]: プラン降格の直後でも「隠さない」方針の確認。disconnect は
// denyIfPlanLacksExternalAnalytics を呼ばない設計だが、それを明示的な
// 回帰ガードとして固定する(GID: connect済みのまま降格してもロックアウトしない)。
describe("DELETE /v1/admin/tenants/:id/ga4/disconnect (降格後も使える)", () => {
  it("plan=standardへ降格済みでも403にならず解除できる(プランチェックを一切行わない)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "carnation" }] }) // UPDATE tenants
      .mockResolvedValueOnce({ rows: [] }); // INSERT ga4_connection_logs

    const res = await request(app)
      .delete("/v1/admin/tenants/carnation/ga4/disconnect")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // queryTenantPlan(SELECT plan FROM tenants)は呼ばれない = plan列すら見ない
    expect(mockQuery.mock.calls.every(([sql]) => !String(sql).match(/SELECT plan FROM tenants/))).toBe(true);
  });
});

// fail-safe方向の確認: queryTenantPlan が未知/null/テナント不在を返す状況でも
// 「開いてしまう」方向に倒れないことを、connect/testルート越しに直接固定する。
describe("POST /v1/admin/tenants/:id/ga4/connect と /test (fail-safe: 未知のplan値)", () => {
  it.each([
    ["plan列がnull", null],
    ["plan列が未知の文字列", "some_future_plan"],
    ["テナント行自体が見つからない(rows: [])", undefined],
  ] as const)("connect: %s のとき403で弾く(UPDATEは実行しない)", async (_label, planValue) => {
    mockQuery.mockResolvedValueOnce({
      rows: planValue === undefined ? [] : [{ plan: planValue }],
    });

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/ga4/connect")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ property_id: "123456789" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["plan列がnull", null],
    ["plan列が未知の文字列", "some_future_plan"],
  ] as const)("test: %s のとき403で弾き、GA4 APIを呼ばない", async (_label, planValue) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: planValue }] });

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/ga4/test")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(403);
    expect(mockedRunGa4HealthCheck).not.toHaveBeenCalled();
  });
});
