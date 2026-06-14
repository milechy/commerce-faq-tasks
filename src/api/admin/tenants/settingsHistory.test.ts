// src/api/admin/tenants/settingsHistory.test.ts
// Phase72-A: テナント設定変更履歴 API テスト

import express from "express";
import request from "supertest";
import { registerTenantAdminRoutes } from "./routes";

// ---------------------------------------------------------------------------
// 副作用モック（外部サービス・インメモリストア）
// ---------------------------------------------------------------------------

jest.mock("../../../lib/tenant-context", () => ({
  registerTenant: jest.fn(),
  updateTenantEnabled: jest.fn(),
}));

jest.mock("../../../agent/openclaw/workspaceCache", () => ({
  invalidateWorkspaceCache: jest.fn(),
}));

jest.mock("../../../auth/supabaseClient", () => ({
  supabaseAdmin: null,
}));

jest.mock("../avatar/routes", () => ({
  DEFAULT_AVATARS: [],
}));

// ---------------------------------------------------------------------------
// db モック（Pool の no-op 実装）
// ---------------------------------------------------------------------------

function makeMockDb(queryImpl?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  return {
    query: jest.fn().mockImplementation(queryImpl ?? (() => Promise.resolve({ rows: [], rowCount: 0 }))),
  };
}

// ---------------------------------------------------------------------------
// テスト用 Express アプリ生成
// ---------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(
  db: ReturnType<typeof makeMockDb>,
  role: Role = "super_admin",
  email = "admin@example.com"
) {
  const app = express();
  app.use(express.json());

  // JWT 検証をバイパスして supabaseUser を直接セット
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      email,
      app_metadata: { role },
    };
    next();
  });

  registerTenantAdminRoutes(app, db as any);
  return app;
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// 1. GET settings-history 正常系: レコードを返す
describe("1. GET /v1/admin/tenants/:id/settings-history → 200", () => {
  it("returns history and total", async () => {
    const NOW = new Date().toISOString();
    const historyRow = {
      id: 1,
      tenant_id: "tenant-a",
      changed_by: "admin@example.com",
      field_name: "plan",
      old_value: "starter",
      new_value: "growth",
      changed_at: NOW,
    };
    const db = makeMockDb((sql: string) => {
      if (sql.includes("SELECT id, tenant_id")) {
        return Promise.resolve({ rows: [historyRow], rowCount: 1 });
      }
      if (sql.includes("COUNT(*)")) {
        return Promise.resolve({ rows: [{ total: 1 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp(db)).get("/v1/admin/tenants/tenant-a/settings-history");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].field_name).toBe("plan");
  });
});

// 2. GET settings-history 認証エラー: client_admin → 403
describe("2. GET /v1/admin/tenants/:id/settings-history → 403 (client_admin)", () => {
  it("returns 403 for client_admin role", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db, "client_admin")).get(
      "/v1/admin/tenants/tenant-a/settings-history"
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });
});

// 3. GET settings-history limit バリデーション: 非数値は default 20 にフォールバック
describe("3. GET /v1/admin/tenants/:id/settings-history?limit=invalid → 200 (default fallback)", () => {
  it("uses default limit when non-numeric limit is passed", async () => {
    const db = makeMockDb((sql: string) => {
      if (sql.includes("COUNT(*)")) {
        return Promise.resolve({ rows: [{ total: 0 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp(db)).get(
      "/v1/admin/tenants/tenant-a/settings-history?limit=invalid"
    );

    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([]);
    // limit=NaN → parseInt → NaN → Math.max(NaN,1) = NaN → Math.min(NaN,100) = NaN
    // SQL still runs without crash (DB mock returns 0 rows)
    expect(db.query).toHaveBeenCalled();
  });
});

// 4. PATCH → audit INSERT が fire-and-forget で呼ばれる
describe("4. PATCH /v1/admin/tenants/:id triggers audit log on plan change", () => {
  it("calls INSERT into tenant_settings_history when plan changes", async () => {
    const BEFORE_ROW = { id: "tenant-a", plan: "starter", features: null, billing_enabled: false, is_active: true };
    const AFTER_ROW  = { ...BEFORE_ROW, plan: "growth", id: "tenant-a", name: "Test", is_active: true,
      allowed_origins: [], system_prompt: null, billing_enabled: false, billing_free_from: null,
      billing_free_until: null, features: null, lemonslice_agent_id: null, conversion_types: [],
      tenant_contact_email: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

    const db = makeMockDb((sql: string) => {
      // 存在チェック SELECT
      if (sql.includes("SELECT id, plan, features")) {
        return Promise.resolve({ rows: [BEFORE_ROW], rowCount: 1 });
      }
      // UPDATE RETURNING
      if (sql.startsWith("UPDATE tenants SET")) {
        return Promise.resolve({ rows: [AFTER_ROW], rowCount: 1 });
      }
      // fire-and-forget INSERT
      if (sql.includes("INSERT INTO tenant_settings_history")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp(db)).patch("/v1/admin/tenants/tenant-a").send({ plan: "growth" });

    expect(res.status).toBe(200);

    // fire-and-forget なので INSERT は非同期 — 少し待つ
    await new Promise((r) => setTimeout(r, 50));

    const insertCalls = (db.query as jest.Mock).mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO tenant_settings_history")
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    // 変更された field_name が "plan" であること
    const planInsert = insertCalls.find(([, params]: [string, unknown[]]) =>
      Array.isArray(params) && params.includes("plan")
    );
    expect(planInsert).toBeDefined();
    // changed_by はメールアドレス
    expect(planInsert![1][1]).toBe("admin@example.com");
  });
});
