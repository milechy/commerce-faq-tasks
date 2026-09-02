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

// [A2A-0d]: /verify は PostHog の外部API(fetch)を実際に叩く接続テストで、
// connect と同じ Growth 以上ゲートが掛かっているはずだが、これまで
// connect/status しかテストされておらず verify のゲート自体が未検証だった。
describe("POST /v1/admin/tenants/:id/posthog/verify (plan gate)", () => {
  const realFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it("403 plan_upgrade_required を返す(plan=standard、DB読み取り・外部API呼び出しのどちらもしない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: "standard" }] }); // queryTenantPlan

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/posthog/verify")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    // plan lookup の1回だけで、posthog_project_api_key_encrypted のSELECTすら呼ばれない
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // ★ゲートが外部API呼び出しの手前にあることの確認★ PostHogへは絶対に到達しない
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("plan=growth なら通過してPostHog APIを呼ぶ", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: "growth" }] }) // queryTenantPlan
      .mockResolvedValueOnce({ rows: [{ posthog_project_api_key_encrypted: "phc_test_key" }] }); // SELECT
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/posthog/verify")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// [A2A-0d]: プラン降格の直後でも「隠さない」方針の確認(GA4側と同じ挙動を揃える)。
// disconnect はプランを確認しない設計(コード上そもそも denyIfPlanLacksExternalAnalytics
// を呼ばない)だが、それを明示的な回帰ガードとして固定する。
describe("DELETE /v1/admin/tenants/:id/posthog/disconnect (降格後も使える)", () => {
  it("plan=starterへ降格済みでも403にならず解除できる(プランチェックを一切行わない)", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "carnation" }] }); // UPDATE

    const res = await request(app)
      .delete("/v1/admin/tenants/carnation/posthog/disconnect")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // queryTenantPlan(SELECT plan FROM tenants)は呼ばれない = plan列すら見ない
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/SELECT plan FROM tenants/);
  });
});

// fail-safe方向の確認: queryTenantPlan が未知/null/空文字を返す状況でも
// 「開いてしまう」方向に倒れないことを、connectルート越しに直接固定する。
describe("POST /v1/admin/tenants/:id/posthog/connect (fail-safe: 未知のplan値)", () => {
  it.each([
    ["plan列がnull", null],
    ["plan列が未知の文字列", "some_future_plan"],
    ["テナント行自体が見つからない(rows: [])", undefined],
  ] as const)("%s のとき403で弾く(UPDATEは実行しない)", async (_label, planValue) => {
    mockQuery.mockResolvedValueOnce({
      rows: planValue === undefined ? [] : [{ plan: planValue }],
    });

    const res = await request(app)
      .post("/v1/admin/tenants/carnation/posthog/connect")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ project_api_key: "phc_test_key" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
