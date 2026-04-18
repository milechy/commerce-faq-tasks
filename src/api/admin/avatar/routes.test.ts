// src/api/admin/avatar/routes.test.ts
// avatar activate/deactivate が tenants.features.avatar を正しく同期するかを検証

import express from "express";
import request from "supertest";
import { registerAvatarConfigRoutes } from "./routes";

// --------------------------------------------------------------------------
// モック
// --------------------------------------------------------------------------

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../../auth/supabaseClient", () => ({
  supabaseAdmin: null,
}));

// --------------------------------------------------------------------------
// ヘルパー
// --------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(db: any, role: Role = "client_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });
  registerAvatarConfigRoutes(app, db);
  return app;
}

const CONFIG_ROW = {
  id: "config-1",
  tenant_id: "tenant-a",
  name: "テストアバター",
  is_active: true,
  is_default: false,
  created_at: new Date().toISOString(),
};

// --------------------------------------------------------------------------
// POST /v1/admin/avatar/configs/:id/activate
// --------------------------------------------------------------------------

describe("POST /v1/admin/avatar/configs/:id/activate", () => {
  it("activate 後に tenants.features.avatar = true を UPDATE する", async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })                      // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })         // deactivate all
      .mockResolvedValueOnce({ rows: [CONFIG_ROW], rowCount: 1 }) // activate target
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })         // UPDATE tenants features
      .mockResolvedValueOnce({ rows: [] });                     // COMMIT

    const db = {
      connect: jest.fn().mockResolvedValue({
        query: clientQuery,
        release: jest.fn(),
      }),
    };

    const res = await request(makeApp(db))
      .post("/v1/admin/avatar/configs/config-1/activate")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("config-1");

    // tenants UPDATE が呼ばれたか確認
    const calls = clientQuery.mock.calls as Array<[string, ...unknown[]]>;
    const tenantUpdate = calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants") && sql.includes("'true'")
    );
    expect(tenantUpdate).toBeDefined();
    expect(tenantUpdate![1]).toEqual(["tenant-a"]); // $1 = effectiveTenantId (配列で渡す)
  });

  it("対象設定が存在しない場合は 404 を返し tenants を更新しない", async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })              // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // deactivate all
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // activate → not found
      .mockResolvedValueOnce({ rows: [] });             // ROLLBACK

    const db = {
      connect: jest.fn().mockResolvedValue({
        query: clientQuery,
        release: jest.fn(),
      }),
    };

    const res = await request(makeApp(db))
      .post("/v1/admin/avatar/configs/nonexistent/activate")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(404);

    const calls = clientQuery.mock.calls as Array<[string, ...unknown[]]>;
    const tenantUpdate = calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants")
    );
    expect(tenantUpdate).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// GET /v1/admin/avatar/configs — r2c_default 包含テスト
// --------------------------------------------------------------------------

describe("GET /v1/admin/avatar/configs", () => {
  const CUSTOM_ROW = {
    id: "cust-1",
    tenant_id: "tenant-a",
    name: "カスタムアバター",
    is_default: false,
    is_active: true,
    created_at: new Date().toISOString(),
  };
  const DEFAULT_ROW = {
    id: "def-1",
    tenant_id: "r2c_default",
    name: "SAM",
    is_default: true,
    is_active: true,
    created_at: new Date().toISOString(),
  };

  it("T1: client_admin → 自テナント + r2c_default が両方返る", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValue({ rows: [CUSTOM_ROW, DEFAULT_ROW] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .get("/v1/admin/avatar/configs");

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(2);

    const [sql, params] = dbQuery.mock.calls[0] as [string, string[]];
    expect(sql).toContain("tenant_id = 'r2c_default'");
    expect(params).toContain("tenant-a");
  });

  it("T2: 自テナントにカスタムなし → r2c_default のみ返る", async () => {
    const dbQuery = jest.fn().mockResolvedValue({ rows: [DEFAULT_ROW] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-empty"))
      .get("/v1/admin/avatar/configs");

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(1);
    expect(res.body.configs[0].tenant_id).toBe("r2c_default");
  });

  it("T3: super_admin ?tenant=carnation → carnation + r2c_default 両方返る", async () => {
    const carnationRow = { ...CUSTOM_ROW, tenant_id: "carnation", id: "carn-1" };
    const dbQuery = jest.fn().mockResolvedValue({ rows: [carnationRow, DEFAULT_ROW] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin", ""))
      .get("/v1/admin/avatar/configs?tenant=carnation");

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(2);

    const [sql, params] = dbQuery.mock.calls[0] as [string, string[]];
    expect(sql).toContain("tenant_id = 'r2c_default'");
    expect(params).toContain("carnation");
  });

  it("T4: super_admin ?tenant=r2c_default → r2c_default のみ返る", async () => {
    const dbQuery = jest.fn().mockResolvedValue({ rows: [DEFAULT_ROW] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin", ""))
      .get("/v1/admin/avatar/configs?tenant=r2c_default");

    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(1);
    expect(res.body.configs[0].tenant_id).toBe("r2c_default");

    const [sql, params] = dbQuery.mock.calls[0] as [string, string[]];
    expect(params).toContain("r2c_default");
  });

  it("T5: ORDER BY is_default ASC が SQL に含まれる (カスタム先頭)", async () => {
    const dbQuery = jest.fn().mockResolvedValue({ rows: [CUSTOM_ROW, DEFAULT_ROW] });
    const db = { query: dbQuery };

    await request(makeApp(db, "client_admin", "tenant-a"))
      .get("/v1/admin/avatar/configs");

    const [sql] = dbQuery.mock.calls[0] as [string, string[]];
    expect(sql).toContain("is_default ASC");
    expect(sql).toContain("created_at DESC");
  });
});

// --------------------------------------------------------------------------
// DELETE /v1/admin/avatar/configs/:id
// --------------------------------------------------------------------------

describe("DELETE /v1/admin/avatar/configs/:id", () => {
  it("削除後にアクティブ設定が残っていない場合 features.avatar = false を UPDATE する", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ ...CONFIG_ROW, is_active: false, tenant_id: "tenant-a" }] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // DELETE
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })  // SELECT COUNT remaining
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // UPDATE tenants features = false

    const db = { query: dbQuery };

    const res = await request(makeApp(db))
      .delete("/v1/admin/avatar/configs/config-1")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const calls = dbQuery.mock.calls as Array<[string, ...unknown[]]>;
    const tenantUpdate = calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants") && sql.includes("'false'")
    );
    expect(tenantUpdate).toBeDefined();
  });

  it("削除後もアクティブ設定が残っている場合 features.avatar は更新しない", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ ...CONFIG_ROW, is_active: false, tenant_id: "tenant-a" }] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // DELETE
      .mockResolvedValueOnce({ rows: [{ count: "1" }] }); // SELECT COUNT remaining → 1件残存

    const db = { query: dbQuery };

    const res = await request(makeApp(db))
      .delete("/v1/admin/avatar/configs/config-1")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);

    const calls = dbQuery.mock.calls as Array<[string, ...unknown[]]>;
    const tenantUpdate = calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE tenants")
    );
    expect(tenantUpdate).toBeUndefined();
  });

  it("アクティブな設定は削除できない（403）", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ ...CONFIG_ROW, is_active: true, tenant_id: "tenant-a" }] }); // SELECT existing

    const db = { query: dbQuery };

    const res = await request(makeApp(db))
      .delete("/v1/admin/avatar/configs/config-1")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(403);
  });
});
