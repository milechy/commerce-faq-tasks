// src/api/admin/tenants/routes.test.ts
// Phase72-A: 監査ログ INSERT と settings-history 取得エンドポイントのテスト

import express from "express";
import request from "supertest";
import { registerTenantAdminRoutes } from "./routes";
import { registerTenant, setTenantApiKeyExpiry, revokeTenantApiKey } from "../../../lib/tenant-context";

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
  revokeTenantApiKey: jest.fn(),
  // 既定は false = in-memory 未登録(DB-onlyテナント)。個別テストで true に上書きする。
  addTenantApiKey: jest.fn().mockReturnValue(false),
  updateTenantAllowedOrigins: jest.fn(),
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

// D1: 会話の段階引き継ぎ(SalesFlow)を画面から開閉できるようにする。
// dialogAgent.ts は実装済みだったが featuresSchema にキーが無く、super_admin の
// PATCH が zod で弾かれて **DB直更新でしか開けられなかった**。
describe("PATCH /v1/admin/tenants/:id — sales_stage_continuity", () => {
  const ROW = {
    id: "tenant-a", name: "テストテナント", plan: "starter", is_active: true,
    allowed_origins: [], system_prompt: null, billing_enabled: false,
    billing_free_from: null, billing_free_until: null,
    features: { avatar: false, voice: false, rag: true },
    lemonslice_agent_id: null, conversion_types: [], tenant_contact_email: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };

  function makeDb(returned: Record<string, unknown>) {
    return {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan: "starter", features: ROW.features, billing_enabled: false, is_active: true }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ ...ROW, features: returned }], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
  }

  it("super_admin は sales_stage_continuity を有効化できる（zodで弾かれない）", async () => {
    const features = { avatar: false, voice: false, rag: true, sales_stage_continuity: true };
    const res = await request(makeApp(makeDb(features), "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ features });

    expect(res.status).toBe(200);
    expect(res.body.features.sales_stage_continuity).toBe(true);
  });

  it("既存の features キーを落とさない（サーバ側は || マージ、送信側も全キーを送る）", async () => {
    const features = {
      avatar: true, voice: true, rag: true,
      hermes_raw_data_consent: true, sales_stage_continuity: true,
    };
    const db = makeDb(features);
    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ features });

    expect(res.status).toBe(200);
    expect(res.body.features.hermes_raw_data_consent).toBe(true);
    expect(res.body.features.avatar).toBe(true);
  });

  it("boolean 以外は 400（\"true\" のような文字列で有効化できない）", async () => {
    const res = await request(makeApp(makeDb({}), "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ features: { avatar: false, voice: false, rag: true, sales_stage_continuity: "true" } });

    expect(res.status).toBe(400);
  });

  it("client_admin は自己申告(my-tenant)で有効化できない（運用者が開ける機能）", async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [ROW], rowCount: 1 }) };
    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy")
      .send({ features: { sales_stage_continuity: true } });

    // my-tenant の features スキーマにキーが無いので、有効化された状態では返らない
    expect(res.body?.features?.sales_stage_continuity).not.toBe(true);
  });
});

// --------------------------------------------------------------------------
// S2: 共有学習プールの参加モデル — 同意の2軸化(features.learning: {learn, share})
// --------------------------------------------------------------------------

describe("PATCH /v1/admin/tenants/:id — features.learning(共有学習プール同意の2軸化)", () => {
  const ROW = {
    id: "tenant-a", name: "テストテナント", plan: "starter", is_active: true,
    allowed_origins: [], system_prompt: null, billing_enabled: false,
    billing_free_from: null, billing_free_until: null,
    features: { avatar: false, voice: false, rag: true },
    lemonslice_agent_id: null, conversion_types: [], tenant_contact_email: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };

  function makeDb(returned: Record<string, unknown>) {
    return {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan: "starter", features: ROW.features, billing_enabled: false, is_active: true }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ ...ROW, features: returned }], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
  }

  it("E8: learn=false かつ share=true は super_admin 経由でも 400", async () => {
    const res = await request(makeApp(makeDb({}), "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ features: { avatar: false, voice: false, rag: true, learning: { learn: false, share: true } } });

    expect(res.status).toBe(400);
  });

  it("learn=true, share=false のような整合する組み合わせは super_admin 経由で更新できる", async () => {
    const features = { avatar: false, voice: false, rag: true, learning: { learn: true, share: false } };
    const res = await request(makeApp(makeDb(features), "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ features });

    expect(res.status).toBe(200);
    expect(res.body.features.learning).toEqual({ learn: true, share: false });
  });

  // S5: super_admin経由のPATCHにも同じ強制ON判定を適用する回帰テスト。
  // beforeRow.plan が free_ad の場合、追加のDBクエリを挟まず(既存のcheckクエリの
  // 結果をそのまま使う)判定できることも合わせて確認する。
  it("S5: beforeRow.plan が free_ad のテナントに share=false を送ると 403", async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan: "free_ad", features: {}, billing_enabled: false, is_active: true }], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ features: { avatar: false, voice: false, rag: true, learning: { learn: true, share: false } } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("share_forced_by_plan");
    // check クエリの1回のみ。強制判定のための追加クエリは発生しない(effectivePlanは
    // 既に取得済みのbeforeRow.planから同期的に解決する)。
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("S5: free_ad → starter への降格と同時に share=false を送るのは正当な操作として通る", async () => {
    const features = { avatar: false, voice: false, rag: true, learning: { learn: true, share: false } };
    const updatedRow = { id: "tenant-a", name: "テストテナント", plan: "starter", is_active: true, allowed_origins: [], system_prompt: null, billing_enabled: false, billing_free_from: null, billing_free_until: null, features, lemonslice_agent_id: null, conversion_types: [], tenant_contact_email: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan: "free_ad", features: {}, billing_enabled: false, is_active: true }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "starter", features });

    expect(res.status).toBe(200);
    expect(res.body.features.learning).toEqual({ learn: true, share: false });
  });

  it("E11: features.learning を送っても avatar 等の既存フラグが消えない（|| マージ、送信側は全キーを送る）", async () => {
    const features = {
      avatar: true, voice: true, rag: true,
      learning: { learn: true, share: true },
    };
    const db = makeDb(features);
    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ features });

    expect(res.status).toBe(200);
    expect(res.body.features.avatar).toBe(true);
    expect(res.body.features.voice).toBe(true);
    expect(res.body.features.learning).toEqual({ learn: true, share: true });
  });
});

describe("PATCH /v1/admin/my-tenant — features.learning(共有学習プール同意の2軸化・自己申告)", () => {
  const ROW = {
    id: "tenant-a", name: "テストテナント",
    features: { avatar: false, voice: false, rag: true },
    lemonslice_agent_id: null, faq_question_hint: null, faq_answer_hint: null,
    onboarding_industry: null, onboarding_completed_at: null, allowed_origins: [],
  };

  it("E8: learn=false かつ share=true は my-tenant(client_admin自己申告)でも 400", async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [ROW], rowCount: 1 }) };
    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy")
      .send({ features: { avatar: false, voice: false, rag: true, learning: { learn: false, share: true } } });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/learn=false.*share=true|learning/);
  });

  it("client_admin は自己申告(my-tenant)で learn/share の整合する組み合わせを更新できる", async () => {
    const updated = { ...ROW, features: { avatar: false, voice: false, rag: true, learning: { learn: true, share: true } } };
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }),
    };
    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy")
      .send({ features: { avatar: false, voice: false, rag: true, learning: { learn: true, share: true } } });

    expect(res.status).toBe(200);
    expect(res.body.features.learning).toEqual({ learn: true, share: true });
  });

  it("E11: my-tenant 経由で features.learning を送っても他の既存フラグ(pre_dispatch)が消えない", async () => {
    // avatar/voice=true は別途プラン制限クエリを挟むため、ここでは無関係のフラグ
    // (pre_dispatch)でマージ挙動のみを確認する。avatar/voiceのゲートは既存の
    // 「PATCH /v1/admin/my-tenant — avatar/voice plan ゲート」describeでカバー済み。
    // share=false を送るため、S5のfree_ad強制ガード(resolveShareForTenantPlan)が
    // 先にプランを1回問い合わせる。starterプランと返し、強制対象でないことを示す。
    const updated = {
      ...ROW,
      features: { avatar: false, voice: false, rag: true, pre_dispatch: true, learning: { learn: true, share: false } },
    };
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ plan: "starter" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }),
    };
    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy")
      .send({ features: { avatar: false, voice: false, rag: true, pre_dispatch: true, learning: { learn: true, share: false } } });

    expect(res.status).toBe(200);
    expect(res.body.features.pre_dispatch).toBe(true);
    expect(res.body.features.learning).toEqual({ learn: true, share: false });
  });

  // S5: HermesConsentToggle等がこのPATCHルートを直接叩いた場合にも、
  // actionExecutor.ts(Copilotツール)と同じfree_ad強制ONの判定を適用する回帰テスト。
  // 導入前はこのルートに判定が無く、free_adテナントがshare=falseを直接PATCHで
  // 送ればCopilot経由の強制を素通りできてしまっていた。
  it("S5: free_adプランのテナントが share=false を送ると 403(強制ONの回避を防ぐ)", async () => {
    const db = {
      query: jest.fn().mockResolvedValueOnce({ rows: [{ plan: "free_ad" }], rowCount: 1 }),
    };
    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy")
      .send({ features: { avatar: false, voice: false, rag: true, learning: { learn: true, share: false } } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("share_forced_by_plan");
  });

  it("S5: free_adでも share=true(強制方向と一致)は判定クエリを挟まず更新できる", async () => {
    const updated = { ...ROW, features: { avatar: false, voice: false, rag: true, learning: { learn: true, share: true } } };
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [updated], rowCount: 1 }) };
    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .set("Authorization", "Bearer dummy")
      .send({ features: { avatar: false, voice: false, rag: true, learning: { learn: true, share: true } } });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

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

  it("plan列が不正/取得不能(fail-safe: free_ad扱い) → 403", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ plan: null }] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ features: { avatar: true, voice: false, rag: true } });

    expect(res.status).toBe(403);
  });

  // free_ad追加後の回帰: nullフォールバック経由ではなく、DBが明示的に"free_ad"を
  // 返す経路(PLAN_RANK['free_ad']の直接lookup)を独立して確認する。
  // rank()の?? PLAN_RANK.free_adフォールバックだけをテストしていると、
  // PLAN_RANK.free_adの値そのものが壊れても検知できない(rank(undefined)は
  // 常にfree_adの値を返すため、フォールバック経路と直接値経路は別コードパス)。
  it("plan='free_ad'(DBの明示値。フォールバックではない) で features.avatar:true → 403", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ plan: "free_ad" }] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ features: { avatar: true, voice: false, rag: true } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("plan='free_ad' で features.voice:true → 403", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ plan: "free_ad" }] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin"))
      .patch("/v1/admin/my-tenant")
      .send({ features: { avatar: false, voice: true, rag: true } });

    expect(res.status).toBe(403);
  });
});

// --------------------------------------------------------------------------
// free_ad プラン追加のP0回帰: プラン設定APIがfree_adを受理する
// --------------------------------------------------------------------------
//
// 実装時に発見したP0バグ: TenantPlan/PLAN_RANK等にfree_adを追加しても、
// このファイルのzod `planValues`(createTenantSchema/updateTenantSchemaが参照する
// ローカル定数)を同時に直さない限り、plan='free_ad'を送るAPIリクエストは
// 400 invalid_requestで拒否される(型はコンパイルが通るのに実行時に壊れる典型例)。
// 型チェック・lintでは検出できず、実機で初めて気づいた。二度と壊さないための回帰テスト。
describe("PATCH /v1/admin/tenants/:id — free_ad プラン受理(P0回帰)", () => {
  // S5b(共有学習プールの参加モデル・D1決定案)により、free_adは消費者向け同意バナー
  // 実装まで一時的に403でブロックされるようになった。ただしこのテストの本来の目的
  // (zodのplanValuesにfree_adが登録されておらず400 invalid_requestで弾かれる、という
  // P0バグの再発防止)は今も生きている: 403(S5bの意図的なブロック)と400(スキーマが
  // 値自体を知らない)は全く別の失敗であり、後者に戻っていないことを確認する。
  it("plan='free_ad' はスキーマ未知の値としては拒否されない(400にはならない。S5bにより403でブロックされる)", async () => {
    const dbQuery = jest.fn();
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .send({ plan: "free_ad" });

    expect(res.status).not.toBe(400);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("free_ad_plan_not_yet_available");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("存在しないプラン文字列('gold'等)は引き続き400で拒否する(何でも通す壊れ方をしていない)", async () => {
    const dbQuery = jest.fn();
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .send({ plan: "gold" });

    expect(res.status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  // S5b: ガードは fields.plan === "free_ad" のみを見る。plan を含まない更新
  // (free_adテナントが既に存在する場合の他フィールド編集を含む)は一律ブロックしない。
  it("S5b: planを含まない更新(free_adテナントの改名等)はブロックしない", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan: "free_ad", features: {}, billing_enabled: false, is_active: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "tenant-a", name: "改名後", plan: "free_ad", is_active: true }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .send({ name: "改名後" });

    expect(res.status).toBe(200);
  });

  // S5b: free_adからの降格(離脱)は同ガードの対象外。塞ぐのは「新規移行」のみ。
  it("S5b: free_ad → starter への降格はブロックしない", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan: "free_ad", features: {}, billing_enabled: false, is_active: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "tenant-a", name: "テストテナント", plan: "starter", is_active: true }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .send({ plan: "starter" });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("starter");
  });
});

describe("POST /v1/admin/tenants — free_ad プラン受理(P0回帰)", () => {
  // S5bにより新規作成時点でのfree_ad指定は403でブロックされる(理由は上記PATCH側と同じ)。
  it("plan='free_ad' を指定したテナント作成はスキーマ未知の値としては拒否されない(S5bにより403でブロックされる)", async () => {
    const dbQuery = jest.fn();
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .post("/v1/admin/tenants")
      .send({ id: "new-tenant", name: "新規テナント", plan: "free_ad" });

    expect(res.status).not.toBe(400);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("free_ad_plan_not_yet_available");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("plan省略時のデフォルトは引き続きstarterであり、free_adへは自動で倒れない(新規テナントは既定で有料想定)", async () => {
    const CREATED_ROW = {
      id: "new-tenant-2",
      name: "新規テナント2",
      plan: "starter",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [CREATED_ROW], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .post("/v1/admin/tenants")
      .send({ id: "new-tenant-2", name: "新規テナント2" });

    expect(res.status).toBe(201);
    // INSERT に渡された plan パラメータそのものを確認(レスポンスはDBモックの値をそのまま
    // 返すだけなので、実際に "starter" がSQLへ渡されたことを見る)
    const [, params] = dbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe("starter");
  });
});

// --------------------------------------------------------------------------
// ⑤ POST /v1/admin/tenants/:id/keys — 発行時に allowedOrigins/features を保持
// --------------------------------------------------------------------------

describe("POST /v1/admin/tenants/:id/keys — in-memory登録がDBの現行設定を上書きしない", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("in-memory未登録(DB-onlyテナント)では、DB上の allowed_origins / features を registerTenant にそのまま引き継ぐ（固定値で上書きしない）", async () => {
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

  it("失効したキーのハッシュで revokeTenantApiKey を呼ぶ（主キー・追加キーを区別しない単一入口）", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({
      rows: [{ id: "key-1", tenant_id: "tenant-a", is_active: false, key_hash: "the-revoked-key-hash" }],
      rowCount: 1,
    });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .delete("/v1/admin/tenants/tenant-a/keys/key-1")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(revokeTenantApiKey).toHaveBeenCalledWith("tenant-a", "the-revoked-key-hash");
  });

  it("存在しないキーIDは404で、revokeTenantApiKeyは呼ばれない", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin"))
      .delete("/v1/admin/tenants/tenant-a/keys/nonexistent")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(404);
    expect(revokeTenantApiKey).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// migration_free_ad_plan.sql — 生SQLテキストの検証
// （実際のDB適用結果は本番/ステージング適用時に確認済み。ここではファイル内容の
//  意図しない改変を検知する。migration_usage_logs_billable_flag.sql と同じ方針）
// --------------------------------------------------------------------------

describe("migration_free_ad_plan.sql", () => {
  const sql = require("fs").readFileSync(
    require("path").join(__dirname, "migration_free_ad_plan.sql"),
    "utf-8"
  ) as string;

  it("既存の3値制約をDROPしてから4値でADDする(片方だけ残ると適用が失敗するかDROPのみで無制約になる)", () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS tenants_plan_check/);
    expect(sql).toMatch(/ADD CONSTRAINT tenants_plan_check/);
    // DROPがADDより前にあること(順序を変えると同名制約の重複エラーになる)
    const dropIdx = sql.indexOf("DROP CONSTRAINT");
    const addIdx = sql.indexOf("ADD CONSTRAINT");
    expect(dropIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(dropIdx);
  });

  it("CHECK制約はfree_ad/starter/growth/enterpriseの4値を過不足なく含む", () => {
    const match = sql.match(/CHECK\s*\(plan IN \(([^)]+)\)\)/);
    expect(match).not.toBeNull();
    const values = (match ? match[1] : "")
      .split(",")
      .map((v) => v.trim().replace(/'/g, ""));
    expect(values.sort()).toEqual(["enterprise", "free_ad", "growth", "starter"]);
  });

  it("DB migrationを自動実行しない方針の注記が含まれる(CLAUDE.md 絶対にやってはいけないこと8)", () => {
    expect(sql).toMatch(/人間承認/);
  });
});

// --------------------------------------------------------------------------
// PUT /v1/admin/my-tenant/plan — テナント自身によるプラン変更
// --------------------------------------------------------------------------

describe("PUT /v1/admin/my-tenant/plan", () => {
  const updatedRow = (plan: string) => ({
    id: "tenant-a", name: "テストテナント", plan, features: { avatar: false, voice: false, rag: true },
  });

  it("client_admin は自テナントのプランを変更でき、変更前後を返す", async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: "starter" }], rowCount: 1 })   // before
        .mockResolvedValueOnce({ rows: [updatedRow("growth")], rowCount: 1 })  // update
        .mockResolvedValue({ rows: [], rowCount: 1 }),                          // audit
    };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("growth");
    expect(res.body.previous_plan).toBe("starter");
    expect(res.body.changed).toBe(true);
  });

  // S5b(#918): free_ad への遷移は同意バナー基盤が整うまで全経路でブロック中。
  // テナント自己申告が super_admin 経路のガードを素通りしないことを固定する。
  // ブロック撤去時は blockFreeAdTransition の中身を変えれば全経路に効く。
  it("free_ad への降格は S5b ブロック中のため 403（DBに触れない）", async () => {
    const db = { query: jest.fn() };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "free_ad" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("free_ad_plan_not_yet_available");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("プラン変更は tenant_settings_history に field_name='plan' で記録される", async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: "starter" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [updatedRow("enterprise")], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "enterprise" });
    await new Promise((r) => setImmediate(r));

    const auditCall = db.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO tenant_settings_history")
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1][0]).toBe("tenant-a");           // tenant_id は JWT 由来
    expect(auditCall![1][2]).toBe(JSON.stringify("starter"));
    expect(auditCall![1][3]).toBe(JSON.stringify("enterprise"));
  });

  it("同じプランへの変更は no-op で、監査行を増やさない", async () => {
    const db = {
      query: jest.fn().mockResolvedValueOnce({ rows: [{ plan: "growth" }], rowCount: 1 }),
    };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(1); // UPDATE も INSERT も走らない
  });

  it("未知のプラン値は 400 で弾く", async () => {
    const db = { query: jest.fn() };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "platinum" });

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  // ★越境防止★ body に tenantId を足しても、更新対象は JWT の tenant_id のまま。
  it("body で他テナントを指定しても JWT のテナントしか更新されない", async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: "starter" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [updatedRow("growth")], rowCount: 1 })
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    await request(makeApp(db, "client_admin", "tenant-a"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth", tenantId: "victim-tenant", tenant_id: "victim-tenant", id: "victim-tenant" });

    for (const [, params] of db.query.mock.calls) {
      expect(JSON.stringify(params ?? [])).not.toContain("victim-tenant");
    }
    const updateCall = db.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("UPDATE tenants SET plan")
    );
    expect(updateCall![1]).toEqual(["growth", "tenant-a"]);
  });

  /**
   * makeApp は role/tenantId にデフォルト引数を持つため、undefined を渡すと
   * 既定値が入ってしまいガードを検証できない。claim 自体を落とした app を組む。
   */
  function makeAppWithClaims(db: any, appMetadata: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.supabaseUser = { email: "admin@example.com", app_metadata: appMetadata };
      next();
    });
    registerTenantAdminRoutes(app, db);
    return app;
  }

  it("role が無いトークン(tenant_idのみ)は 403", async () => {
    const db = { query: jest.fn() };
    const res = await request(makeAppWithClaims(db, { tenant_id: "tenant-a" }))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("tenant_id claim が無い場合は 403（super_admin でも自テナント扱いにしない）", async () => {
    const db = { query: jest.fn() };
    const res = await request(makeAppWithClaims(db, { role: "super_admin" }))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// PUT /v1/admin/my-tenant/plan — 壊れやすい箇所を突くテスト
//
// 方針: 「呼ばれたか」をスパイで見るのではなく、観測可能な副作用
// (キャッシュの中身・DBに飛んだSQL・レスポンス)で判定する。
// スパイは実装を差し替えても気づけないことがあるため。
// --------------------------------------------------------------------------

describe("PUT /v1/admin/my-tenant/plan — 境界・異常系", () => {
  const updatedRow = (plan: string) => ({
    id: "tenant-a", name: "テストテナント", plan, features: { avatar: false, voice: false, rag: true },
  });
  /** before(SELECT) → UPDATE → 監査INSERT の順で応答するモック */
  const okDb = (before: string, after: string) => ({
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ plan: before }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedRow(after)], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 }),
  });

  // ★最重要★ blockFreeAdTransition は「free_ad へ行く」ことだけを塞ぐ。
  // 判定を previousPlan 側に書き換えると free_ad テナントが有料へ上がれなくなり、
  // 課金できないまま閉じ込められる（収益が止まる方向の事故）。
  it("free_ad テナントは有料プランへアップグレードできる（降格ブロックに巻き込まれない）", async () => {
    const db = okDb("free_ad", "growth");
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("growth");
    expect(res.body.previous_plan).toBe("free_ad");
  });

  it.each(["starter", "growth", "enterprise"])(
    "free_ad から %s への昇格は 403 にならない",
    async (target) => {
      const db = okDb("free_ad", target);
      const res = await request(makeApp(db, "client_admin"))
        .put("/v1/admin/my-tenant/plan")
        .set("Authorization", "Bearer dummy")
        .send({ plan: target });
      expect(res.status).toBe(200);
    }
  );

  // ★重要★ この2行を消してもレスポンスは200のままなので、
  // キャッシュの中身を直接見ないと退行に気づけない。
  // 消えると: 機能ゲートが最大60秒古いプランで判定され、
  // usage_logs にも旧倍率が最大60秒焼き付く（課金がズレる）。
  it("プラン変更で機能ゲート用キャッシュが実際に消える", async () => {
    const { tenantPlanCache } = require("../../../lib/billing/planFeatures");
    tenantPlanCache.set("tenant-a", { plan: "starter", expiresAt: Date.now() + 60_000 });
    expect(tenantPlanCache.has("tenant-a")).toBe(true);

    await request(makeApp(okDb("starter", "growth"), "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(tenantPlanCache.has("tenant-a")).toBe(false);
  });

  it("他テナントのキャッシュは巻き込まない（テナント境界）", async () => {
    const { tenantPlanCache } = require("../../../lib/billing/planFeatures");
    tenantPlanCache.set("tenant-a", { plan: "starter", expiresAt: Date.now() + 60_000 });
    tenantPlanCache.set("other-tenant", { plan: "enterprise", expiresAt: Date.now() + 60_000 });

    await request(makeApp(okDb("starter", "growth"), "client_admin", "tenant-a"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(tenantPlanCache.has("tenant-a")).toBe(false);
    expect(tenantPlanCache.get("other-tenant")?.plan).toBe("enterprise");
  });

  it("no-op（同一プラン）のときはキャッシュを触らない副作用も無い", async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ plan: "growth" }], rowCount: 1 }) };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.body.changed).toBe(false);
    // UPDATE も監査INSERTも走らない（SELECT 1本だけ）
    expect(db.query).toHaveBeenCalledTimes(1);
    const sqls = db.query.mock.calls.map(([s]: [string]) => s).join(" ");
    expect(sqls).not.toMatch(/UPDATE tenants/);
    expect(sqls).not.toMatch(/tenant_settings_history/);
  });

  it("テナントが存在しない場合は 404（UPDATE を走らせない）", async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }) };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(404);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  // SELECT と UPDATE の間にテナントが消える競合。UPDATE が0行なら 404 にする。
  it("SELECT 後に行が消えた場合(UPDATE 0行)は 404", async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: "starter" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(404);
  });

  it("DBエラーは 200 で握り潰さず 500 を返す", async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error("connection terminated")) };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(500);
  });

  // ★監査は fire-and-forget★ await に変えると、履歴テーブルの不調で
  // プラン変更そのものが 500 になる。ユーザー操作を監査の都合で失敗させない。
  it("監査INSERTが失敗してもプラン変更は成功として返る", async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ plan: "starter" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [updatedRow("growth")], rowCount: 1 })
        .mockRejectedValue(new Error("tenant_settings_history is missing")),
    };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("growth");
    await new Promise((r) => setImmediate(r)); // 未処理拒否で落ちないこと
  });

  it("UPDATE は必ず updated_at を更新する（変更時刻が追えなくなるのを防ぐ）", async () => {
    const db = okDb("starter", "growth");
    await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    const updateCall = db.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("UPDATE tenants")
    );
    expect(updateCall![0]).toMatch(/updated_at\s*=\s*NOW\(\)/);
  });

  // 不正な plan 値。zod の enum を素通りする形が無いことを固定する。
  it.each([
    ["未知の文字列", { plan: "platinum" }],
    ["plan 欠落", {}],
    ["null", { plan: null }],
    ["数値", { plan: 1 }],
    ["配列", { plan: ["growth"] }],
    ["大文字", { plan: "GROWTH" }],
    ["前後空白", { plan: " growth " }],
    ["空文字", { plan: "" }],
  ])("不正な plan (%s) は 400 で、DBに一切触れない", async (_label, body) => {
    const db = { query: jest.fn() };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send(body as object);

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  // ★free_ad ブロックは DB に触れる前に効くこと★
  // 後段に置くと、ブロックされた要求でも SELECT が走り、
  // 「弾いたのにDB負荷はかかる」状態になる。
  it("free_ad への降格は SELECT すら走らせずに 403", async () => {
    const db = { query: jest.fn() };
    const res = await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "free_ad" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("free_ad_plan_not_yet_available");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("監査の changed_by は JWT の email。無ければ空文字で落ちない", async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      // email を持たないトークン
      req.supabaseUser = { app_metadata: { tenant_id: "tenant-a", role: "client_admin" } };
      next();
    });
    const db = okDb("starter", "growth");
    registerTenantAdminRoutes(app, db as any);

    const res = await request(app)
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });
    await new Promise((r) => setImmediate(r));

    expect(res.status).toBe(200);
    const auditCall = db.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("tenant_settings_history")
    );
    expect(auditCall![1][1]).toBe("");
  });

  // 全プラン遷移の網羅（free_ad 行きだけが 403、それ以外は通る）
  const PAID = ["starter", "growth", "enterprise"] as const;
  it.each(PAID.flatMap((f) => PAID.filter((t) => t !== f).map((t) => [f, t])))(
    "有料間の遷移 %s → %s は許可される",
    async (from, to) => {
      const db = okDb(from, to);
      const res = await request(makeApp(db, "client_admin"))
        .put("/v1/admin/my-tenant/plan")
        .set("Authorization", "Bearer dummy")
        .send({ plan: to });
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe(to);
    }
  );
});

// --------------------------------------------------------------------------
// ★ダウングレード時に、新プランで許されない features を落とすこと★
//
// アバターのランタイム認可は plan ではなく features.avatar だけを見ている
// (src/api/avatar/anamRoutes.ts / livekitTokenRoutes.ts / api/widget/routes.ts)。
// plan だけ下げて features を残すと、最も原価の重い Anam/LiveKit が動いたまま
// 倍率だけ 1.5→1.0 に下がる。UI は「使えなくなる機能: AIアバター」と明示している
// ので、表示と実挙動が食い違う状態にもなる。
// --------------------------------------------------------------------------
describe("PUT /v1/admin/my-tenant/plan — 降格時の features 整合", () => {
  const before = (plan: string, features: object) => ({
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ plan, features }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "tenant-a", name: "t", plan: "starter", features: {} }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 }),
  });

  const updateParams = (db: any) =>
    db.query.mock.calls.find(([sql]: [string]) => typeof sql === "string" && sql.includes("UPDATE tenants"))![1];

  it("growth → starter で features.avatar / voice を false にする", async () => {
    const db = before("growth", { avatar: true, voice: true, rag: true });
    await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "starter" });

    const patch = JSON.parse(updateParams(db).find((p: unknown) => typeof p === "string" && p.startsWith("{")) as string);
    expect(patch.avatar).toBe(false);
    expect(patch.voice).toBe(false);
    // 差分だけを || でマージする。プランに紐づかない rag を差分に含めない
    // (含めると、無関係なフラグを取り違えて上書きしうる)。
    expect(patch).not.toHaveProperty("rag");
    const sql = db.query.mock.calls.find(([q]: [string]) => q.includes("UPDATE tenants"))![0];
    expect(sql).toMatch(/features\s*=\s*COALESCE\(features, '\{\}'::jsonb\)\s*\|\|/);
  });

  it("enterprise → growth で enterprise 限定機能だけ落ちる", async () => {
    const db = before("enterprise", { avatar: true, voice: true, rag: true, deep_research: true, pre_dispatch: true });
    await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    const patch = JSON.parse(updateParams(db).find((p: unknown) => typeof p === "string" && p.startsWith("{")) as string);
    expect(patch.deep_research).toBe(false);
    expect(patch.pre_dispatch).toBe(false);
    // growth で許される avatar は取り消し対象に入れない(維持される)
    expect(patch).not.toHaveProperty("avatar");
    expect(patch).not.toHaveProperty("voice");
  });

  it("アップグレードでは features を勝手に有効化しない（権能の自動付与をしない）", async () => {
    const db = before("starter", { avatar: false, voice: false, rag: true });
    await request(makeApp(db, "client_admin"))
      .put("/v1/admin/my-tenant/plan")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "enterprise" });

    const merged = updateParams(db).find((p: unknown) => typeof p === "string" && (p as string).startsWith("{"));
    if (merged) {
      const f = JSON.parse(merged as string);
      expect(f.avatar).not.toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// PATCH /v1/admin/tenants/:id — 降格時の features 整合(PUT側との対称テスト)
//
// PUT /v1/admin/my-tenant/plan(#933)は features 剥奪を実装したが、この
// super_admin用PATCHルートは plan を更新するだけで features を一切見ていなかった。
// PUT側と同じ計算(computeFeatureRevocationOnDowngrade)を共有しているので、
// ここで壊れれば PUT側のテストとは無関係に検出できることを確認する。
// --------------------------------------------------------------------------
describe("PATCH /v1/admin/tenants/:id — 降格時の features 整合", () => {
  const RETURNING_ROW = { id: "tenant-a", name: "t", plan: "starter", is_active: true, allowed_origins: [], system_prompt: null, billing_enabled: false, billing_free_from: null, billing_free_until: null, lemonslice_agent_id: null, conversion_types: [], tenant_contact_email: null, faq_question_hint: null, faq_answer_hint: null, created_at: "2026-01-01", updated_at: "2026-01-01" };

  function before(plan: string, features: object) {
    return {
      query: jest.fn()
        // 存在チェック + before フィールド取得
        .mockResolvedValueOnce({ rows: [{ id: "tenant-a", plan, features, billing_enabled: false, is_active: true }], rowCount: 1 })
        // UPDATE ... RETURNING
        .mockResolvedValueOnce({ rows: [{ ...RETURNING_ROW, features: {} }], rowCount: 1 })
        // tenant_settings_history INSERT(監査、fire-and-forget) x 複数
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
  }

  const updateCall = (db: any) => db.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE tenants"));
  const featuresParams = (db: any) =>
    (updateCall(db)![1] as unknown[]).filter((p) => typeof p === "string" && p.startsWith("{")).map((p) => JSON.parse(p as string));

  it("super_admin が growth → starter へ降格させると features.avatar / voice が false になる(PUT側と対称)", async () => {
    const db = before("growth", { avatar: true, voice: true, rag: true });
    const res = await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "starter" });

    expect(res.status).toBe(200);
    const [revoked] = featuresParams(db);
    expect(revoked).toEqual({ avatar: false, voice: false });
    const sql = updateCall(db)[0];
    expect(sql).toMatch(/features\s*=\s*COALESCE\(features, '\{\}'::jsonb\)\s*\|\|/);
  });

  it("plan を送らなければ features には一切触れない(既存の非plan更新を壊さない)", async () => {
    const db = before("starter", { avatar: false, voice: false, rag: true });
    await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ name: "新しい名前" });

    const call = updateCall(db);
    expect(call[0]).not.toMatch(/features\s*=/);
  });

  // ★super_adminであってもプランを超えた権能付与はさせない(planFeatures.ts冒頭の境界)★
  // 同一リクエストで plan降格 と features.avatar=true の明示指定が衝突した場合、
  // 剥奪が最後に適用され勝つこと。jsonbの || は右側のキーが勝つため、
  // マージ順(admin指定 → revoked)を直接検証する。
  it("同一リクエストでplan降格とfeatures.avatar=trueが衝突すると、剥奪が勝つ", async () => {
    const db = before("growth", { avatar: true, voice: true });
    await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      // featuresSchema は avatar/voice/rag が必須。同一リクエストでadminがavatar=trueを
      // 明示指定しつつ、plan降格による剥奪と衝突させる。
      .send({ plan: "starter", features: { avatar: true, voice: false, rag: true } });

    const [adminLayer, revokedLayer] = featuresParams(db);
    expect(adminLayer).toEqual({ avatar: true, voice: false, rag: true }); // 管理者が明示指定した値
    expect(revokedLayer).toEqual({ avatar: false, voice: false }); // 剥奪(最後に適用され勝つ)
    const sql = updateCall(db)[0];
    // マージ順: COALESCE(...) || $adminLayer || $revokedLayer
    expect(sql.indexOf("features")).toBeLessThan(sql.length);
  });

  it("enterprise → growth では enterprise限定機能だけ落ち、growthで許されるavatarは維持される", async () => {
    const db = before("enterprise", { avatar: true, voice: true, deep_research: true, pre_dispatch: true });
    await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    const [revoked] = featuresParams(db);
    expect(revoked).toEqual({ deep_research: false, pre_dispatch: false });
  });

  it("アップグレードでは features に触れない(権能の自動付与をしない)", async () => {
    const db = before("starter", { avatar: false, voice: false });
    await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "enterprise" });

    const call = updateCall(db);
    expect(call[0]).not.toMatch(/features\s*=/);
  });

  // ★#921で入れたキャッシュ無効化がPATCH側にも効いていること★
  // 導入時はPUT側にしか実装されておらず、PATCH側は plan 変更経路として
  // 先にあったにもかかわらず素通りしていた。
  it("plan変更でプランキャッシュ(機能ゲート用・請求焼き付け用)が両方消える", async () => {
    const { tenantPlanCache } = require("../../../lib/billing/planFeatures");
    tenantPlanCache.set("tenant-a", { plan: "starter", expiresAt: Date.now() + 60_000 });

    const db = before("starter", {});
    await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ plan: "growth" });

    expect(tenantPlanCache.has("tenant-a")).toBe(false);
  });

  it("plan を送らない更新ではプランキャッシュに触れない", async () => {
    const { tenantPlanCache } = require("../../../lib/billing/planFeatures");
    tenantPlanCache.set("tenant-a", { plan: "starter", expiresAt: Date.now() + 60_000 });

    const db = before("starter", {});
    await request(makeApp(db, "super_admin"))
      .patch("/v1/admin/tenants/tenant-a")
      .set("Authorization", "Bearer dummy")
      .send({ name: "新しい名前" });

    expect(tenantPlanCache.has("tenant-a")).toBe(true);
  });
});
