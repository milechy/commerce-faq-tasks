// src/api/admin/tenants/routes.test.ts
// Phase72-A: 監査ログ INSERT と settings-history 取得エンドポイントのテスト

import express from "express";
import request from "supertest";
import { registerTenantAdminRoutes } from "./routes";
import { registerTenant, setTenantApiKeyExpiry, revokeTenantApiKeyIfCurrent } from "../../../lib/tenant-context";

// --------------------------------------------------------------------------
// モック
// --------------------------------------------------------------------------

jest.mock("../../../auth/supabaseClient", () => ({
  supabaseAdmin: null,
}));

jest.mock("../../../lib/tenant-context", () => ({
  registerTenant: jest.fn(),
  updateTenantEnabled: jest.fn(),
  setTenantApiKeyExpiry: jest.fn(),
  revokeTenantApiKeyIfCurrent: jest.fn(),
}));

jest.mock("../../../agent/openclaw/workspaceCache", () => ({
  invalidateWorkspaceCache: jest.fn(),
}));

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

// --------------------------------------------------------------------------
// ヘルパー
// --------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(db: any, role: Role = "super_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  // テスト用: 認証ミドルウェアをバイパスして supabaseUser を直接注入
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      email: "admin@example.com",
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });
  registerTenantAdminRoutes(app, db);
  return app;
}

// --------------------------------------------------------------------------
// ① PATCH /v1/admin/tenants/:id — plan 変更で INSERT INTO tenant_settings_history
// --------------------------------------------------------------------------

describe("PATCH /v1/admin/tenants/:id — Phase72-A 監査ログ", () => {
  it("plan 変更時に tenant_settings_history への INSERT が呼ばれる", async () => {
    const TENANT_ROW = {
      id: "tenant-a",
      name: "テストテナント",
      plan: "starter",
      is_active: true,
      allowed_origins: [],
      system_prompt: null,
      billing_enabled: false,
      billing_free_from: null,
      billing_free_until: null,
      features: { avatar: false, voice: false, rag: true },
      lemonslice_agent_id: null,
      conversion_types: [],
      tenant_contact_email: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const dbQuery = jest
      .fn()
      // 存在チェック + before フィールド取得
      .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan: "starter", features: { avatar: false, voice: false, rag: true }, billing_enabled: false, is_active: true }], rowCount: 1 })
      // UPDATE ... RETURNING
      .mockResolvedValueOnce({ rows: [{ ...TENANT_ROW, plan: "growth" }], rowCount: 1 })
      // INSERT INTO tenant_settings_history (fire-and-forget)
      .mockResolvedValue({ rows: [], rowCount: 1 });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("growth");

    // fire-and-forget なので少し待つ
    await new Promise((r) => setTimeout(r, 50));

    const calls = dbQuery.mock.calls as Array<[string, ...unknown[]]>;
    const insertCall = calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("INSERT INTO tenant_settings_history")
    );
    expect(insertCall).toBeDefined();
    // $3 = field_name, $4 = old_value, $5 = new_value
    expect(insertCall![1]).toContain("plan");
  });

  it("値が変わらないフィールドは INSERT されない", async () => {
    const TENANT_ROW = {
      id: "tenant-a",
      name: "テストテナント",
      plan: "starter",
      is_active: true,
      allowed_origins: [],
      system_prompt: null,
      billing_enabled: false,
      billing_free_from: null,
      billing_free_until: null,
      features: { avatar: false, voice: false, rag: true },
      lemonslice_agent_id: null,
      conversion_types: [],
      tenant_contact_email: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const dbQuery = jest
      .fn()
      // 存在チェック — name のみ変更（plan/features/billing_enabled/is_active は同一）
      .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan: "starter", features: { avatar: false, voice: false, rag: true }, billing_enabled: false, is_active: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...TENANT_ROW, name: "変更後" }], rowCount: 1 });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ name: "変更後" });

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    const calls = dbQuery.mock.calls as Array<[string, ...unknown[]]>;
    const insertCall = calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        sql.includes("INSERT INTO tenant_settings_history")
    );
    expect(insertCall).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// ② GET /v1/admin/tenants/:id/settings-history — { history, total } を返す
// --------------------------------------------------------------------------

describe("GET /v1/admin/tenants/:id/settings-history", () => {
  const HISTORY_ROW = {
    id: 1,
    tenant_id: "tenant-a",
    changed_by: "admin@example.com",
    field_name: "plan",
    old_value: '"starter"',
    new_value: '"growth"',
    changed_at: new Date().toISOString(),
  };

  it("super_admin が呼ぶと { history, total } を返す", async () => {
    const dbQuery = jest
      .fn()
      // データクエリ
      .mockResolvedValueOnce({ rows: [HISTORY_ROW], rowCount: 1 })
      // カウントクエリ
      .mockResolvedValueOnce({ rows: [{ total: 1 }], rowCount: 1 });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .get("/v1/admin/tenants/tenant-a/settings-history")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("history");
    expect(res.body).toHaveProperty("total");
    expect(Array.isArray(res.body.history)).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.history[0].field_name).toBe("plan");
  });

  it("limit/offset パラメータが正しくクエリに渡される", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 });

    const db = { query: dbQuery };

    await request(makeApp(db, "super_admin"))
      .get("/v1/admin/tenants/tenant-a/settings-history?limit=5&offset=10")
      .set("Authorization", "Bearer dummy");

    const calls = dbQuery.mock.calls as Array<[string, ...unknown[]]>;
    // データクエリの引数に limit=5, offset=10 が含まれること
    const dataCall = calls.find(([sql]) => typeof sql === "string" && sql.includes("ORDER BY changed_at"));
    expect(dataCall).toBeDefined();
    expect(dataCall![1]).toContain(5);
    expect(dataCall![1]).toContain(10);
  });
});

// --------------------------------------------------------------------------
// ③ client_admin が GET settings-history を呼ぶと 403
// --------------------------------------------------------------------------

describe("GET /v1/admin/tenants/:id/settings-history — 権限チェック", () => {
  it("client_admin だと 403 を返す", async () => {
    const db = { query: jest.fn() };

    const res = await request(makeApp(db, "client_admin"))
      .get("/v1/admin/tenants/tenant-a/settings-history")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// ④ limit=invalid (非数値) は NaN になるがクラッシュせず 200 を返す
// --------------------------------------------------------------------------

describe("GET /v1/admin/tenants/:id/settings-history — limit バリデーション", () => {
  it("非数値の limit を渡してもクラッシュせず 200 を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .get("/v1/admin/tenants/tenant-a/settings-history?limit=invalid")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([]);
    expect(dbQuery).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// ⑤ PATCH → changed_by に supabaseUser.email が記録される
// --------------------------------------------------------------------------

describe("PATCH /v1/admin/tenants/:id — changed_by にメールが入る", () => {
  it("INSERT の $2 パラメータが supabaseUser.email と一致する", async () => {
    const BEFORE_ROW = { id: "tenant-a", plan: "starter", features: null, billing_enabled: false, is_active: true };
    const AFTER_ROW = {
      ...BEFORE_ROW, plan: "growth", name: "Test", allowed_origins: [], system_prompt: null,
      billing_free_from: null, billing_free_until: null, lemonslice_agent_id: null,
      conversion_types: [], tenant_contact_email: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [BEFORE_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [AFTER_ROW], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    const calls = dbQuery.mock.calls as Array<[string, unknown[]]>;
    const insertCall = calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO tenant_settings_history")
    );
    expect(insertCall).toBeDefined();
    // $2 = changed_by = supabaseUser.email
    expect(insertCall![1][1]).toBe("admin@example.com");
  });
});

// --------------------------------------------------------------------------
// ⑥ GET /v1/admin/my-tenant — has_r2c2 (App Switcher 用、AaaS aaas_clients 連携)
// --------------------------------------------------------------------------

describe("GET /v1/admin/my-tenant — has_r2c2", () => {
  const TENANT_ROW = { id: "tenant-a", name: "テストテナント", features: null, lemonslice_agent_id: null, conversion_types: [] };

  it("aaas_clients に紐付くテナントは has_r2c2: true を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .get("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.has_r2c2).toBe(true);
  });

  it("aaas_clients に紐付かないテナントは has_r2c2: false を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .get("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.has_r2c2).toBe(false);
  });

  it("aaas_clients クエリが失敗しても(未マイグレーション等) 500にせず has_r2c2: false で返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
      .mockRejectedValueOnce(new Error('relation "aaas_clients" does not exist'));
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .get("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.has_r2c2).toBe(false);
  });
});

// --------------------------------------------------------------------------
// widget_theme — get_embed_code(チャットツール)の data-accent-color 反映元。
// GET 応答から欠落すると、super_admin 側の EmbedCodeTab.tsx が反映を検知できない。
// --------------------------------------------------------------------------

describe("GET /v1/admin/my-tenant / GET /v1/admin/tenants/:id — widget_theme", () => {
  it("GET /v1/admin/my-tenant は widget_theme を応答に含める", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: "tenant-a", name: "テストテナント", features: null, lemonslice_agent_id: null, conversion_types: [], widget_theme: { primaryColor: "#3B82F6" } }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .get("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.widget_theme).toEqual({ primaryColor: "#3B82F6" });
  });

  it("GET /v1/admin/tenants/:id (super_admin) は widget_theme を応答に含める", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({
      rows: [{ id: "tenant-a", name: "テストテナント", features: null, lemonslice_agent_id: null, conversion_types: [], widget_theme: { primaryColor: "#3B82F6" } }],
      rowCount: 1,
    });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .get("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.widget_theme).toEqual({ primaryColor: "#3B82F6" });
  });
});

// --------------------------------------------------------------------------
// ⑦ PATCH /v1/admin/my-tenant — avatar/voice の plan ゲート(LP料金表: Growth〜)
// --------------------------------------------------------------------------

describe("PATCH /v1/admin/my-tenant — avatar/voice plan ゲート", () => {
  const UPDATED_ROW = { id: "tenant-a", name: "テストテナント", features: { avatar: true, voice: false, rag: true } };

  it("plan=growth で features.avatar:true → 200(plan確認クエリ→UPDATE の順)", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ plan: "growth" }] })
      .mockResolvedValueOnce({ rows: [UPDATED_ROW], rowCount: 1 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ features: { avatar: true, voice: false, rag: true } });

    expect(res.status).toBe(200);
    expect(dbQuery).toHaveBeenCalledTimes(2);
  });

  it("plan=starter で features.avatar:true → 403 plan_upgrade_required、UPDATEは呼ばれない", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ features: { avatar: true, voice: false, rag: true } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("plan=starter で features.voice:true → 403", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ plan: "starter" }] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ features: { avatar: false, voice: true, rag: true } });

    expect(res.status).toBe(403);
  });

  it("plan=starter でも features.avatar/voiceを両方falseにする(OFFにする)場合はplan確認をスキップして200", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ ...UPDATED_ROW, features: { avatar: false, voice: false, rag: true } }], rowCount: 1 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ features: { avatar: false, voice: false, rag: true } });

    expect(res.status).toBe(200);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("plan=starter でもfeatures以外のフィールド更新はplan確認をスキップする", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [UPDATED_ROW], rowCount: 1 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ faq_question_hint: "配送は何日かかりますか？" });

    expect(res.status).toBe(200);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("plan列が不正/取得不能(fail-safe: starter扱い) → 403", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ plan: null }] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ features: { avatar: true, voice: false, rag: true } });

    expect(res.status).toBe(403);
  });
});

// --------------------------------------------------------------------------
// ⑤ POST /v1/admin/tenants/:id/keys — 発行時に allowedOrigins/features を保持
// --------------------------------------------------------------------------

describe("POST /v1/admin/tenants/:id/keys — in-memory登録がDBの現行設定を上書きしない", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("DB上の allowed_origins / features を registerTenant にそのまま引き継ぐ（固定値で上書きしない）", async () => {
    const dbQuery = jest
      .fn()
      // テナント存在チェック（features/allowed_originsも取得）
      .mockResolvedValueOnce({
        rows: [{
          id: "tenant-a",
          name: "テストテナント",
          plan: "growth",
          is_active: true,
          features: { avatar: true, voice: true, rag: true },
          allowed_origins: ["https://shop.example.com"],
        }],
        rowCount: 1,
      })
      // INSERT INTO tenant_api_keys ... RETURNING
      .mockResolvedValueOnce({
        rows: [{ id: "key-1", tenant_id: "tenant-a", key_prefix: "rjc_abcd1234", is_active: true, created_at: new Date().toISOString(), expires_at: null }],
        rowCount: 1,
      });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .post("/v1/admin/tenants/tenant-a/keys")
      .set("Authorization", "Bearer dummy")
      .send({});

    expect(res.status).toBe(201);
    expect(registerTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        features: { avatar: true, voice: true, rag: true },
        security: expect.objectContaining({ allowedOrigins: ["https://shop.example.com"] }),
      })
    );
    expect(setTenantApiKeyExpiry).toHaveBeenCalledWith("tenant-a", null);
  });

  it("expires_at 指定時に setTenantApiKeyExpiry へ渡す", async () => {
    const expiresAtIso = new Date(Date.now() + 86_400_000).toISOString();
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: "tenant-a", name: "テストテナント", plan: "starter", is_active: true, features: {}, allowed_origins: [] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: "key-2", tenant_id: "tenant-a", key_prefix: "rjc_xyz98765", is_active: true, created_at: new Date().toISOString(), expires_at: expiresAtIso }],
        rowCount: 1,
      });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .post("/v1/admin/tenants/tenant-a/keys")
      .set("Authorization", "Bearer dummy")
      .send({ expires_at: expiresAtIso });

    expect(res.status).toBe(201);
    expect(setTenantApiKeyExpiry).toHaveBeenCalledWith("tenant-a", expect.any(Date));
  });
});

// --------------------------------------------------------------------------
// ⑥ DELETE /v1/admin/tenants/:id/keys/:keyId — 失効を即時にin-memoryへ反映
// --------------------------------------------------------------------------

describe("DELETE /v1/admin/tenants/:id/keys/:keyId — PM2再起動を待たずに失効", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("失効したキーのハッシュで revokeTenantApiKeyIfCurrent を呼ぶ", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({
      rows: [{ id: "key-1", tenant_id: "tenant-a", is_active: false, key_hash: "the-revoked-key-hash" }],
      rowCount: 1,
    });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .delete("/v1/admin/tenants/tenant-a/keys/key-1")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(revokeTenantApiKeyIfCurrent).toHaveBeenCalledWith("tenant-a", "the-revoked-key-hash");
  });

  it("存在しないキーIDは404で、revokeTenantApiKeyIfCurrentは呼ばれない", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .delete("/v1/admin/tenants/tenant-a/keys/nonexistent")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(404);
    expect(revokeTenantApiKeyIfCurrent).not.toHaveBeenCalled();
  });
});
