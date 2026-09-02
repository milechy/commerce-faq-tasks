// src/api/admin/avatar/avatarAdoptRoute.test.ts
// POST /v1/admin/avatar/configs/:id/adopt
// r2c_default 所有のデフォルトアバターは /activate では有効化できない
// (tenant_id 不一致で UPDATE が 0 件 → 404)。自テナント所有として複製してから
// 有効化する adopt エンドポイントが、複製列・排他・プランゲートを正しく扱うかを検証する。

import express from "express";
import { request } from "../../../../tests/helpers/testServer";
import { registerAvatarConfigRoutes } from "./routes";

// --------------------------------------------------------------------------
// モック（routes.test.ts の activate テストと同じパターン）
// --------------------------------------------------------------------------

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../../auth/supabaseClient", () => ({
  supabaseAdmin: null,
}));

// avatar 機能の最低プランは standard。既定は standard（成功パス）で、
// プラン制限テストのみ個別に上書きする。
const mockQueryTenantPlan = jest.fn().mockResolvedValue("standard");
jest.mock("../../../lib/billing/planFeatures", () => {
  const actual = jest.requireActual("../../../lib/billing/planFeatures");
  return {
    ...actual,
    queryTenantPlan: (...args: any[]) => mockQueryTenantPlan(...args),
    planHasFeature: actual.planHasFeature, // 実装をそのまま使う（純関数、モック不要）
  };
});

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

// r2c_default 所有のデフォルトアバター（複製元）
const SOURCE_ROW = {
  id: "default-1",
  tenant_id: "r2c_default",
  name: "Haruka",
  image_url: "https://example.com/haruka.png",
  voice_id: "voice-abc",
  personality_prompt: "テストpersonality",
  agent_prompt: "agent prompt",
  agent_idle_prompt: "idle prompt",
  behavior_description: "behavior desc",
  avatar_provider: "lemonslice",
  category_persona_map: { product: { image_url: "https://example.com/product.png" } },
  lemonslice_agent_id: "agent_5bdbe2f531f79e51",
  is_default: true,
  is_active: true,
};

// adopt後の複製行（DB側で採番・is_default/is_activeが確定した想定）
const ADOPTED_ROW = {
  ...SOURCE_ROW,
  id: "adopted-1",
  tenant_id: "tenant-a",
  is_default: false,
  is_active: true,
  lemonslice_agent_id: null,
};

function makeDb(clientQuery: jest.Mock) {
  return {
    connect: jest.fn().mockResolvedValue({
      query: clientQuery,
      release: jest.fn(),
    }),
  };
}

// --------------------------------------------------------------------------
// POST /v1/admin/avatar/configs/:id/adopt
// --------------------------------------------------------------------------

describe("POST /v1/admin/avatar/configs/:id/adopt", () => {
  it("デフォルトを複製・有効化し、lemonslice_agent_idを持たず is_default=false の行を返す", async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [SOURCE_ROW], rowCount: 1 }) // 複製元 SELECT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // 同テナント既存を全て deactivate
      .mockResolvedValueOnce({ rows: [ADOPTED_ROW], rowCount: 1 }) // INSERT（複製+有効化）
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE tenants.features.avatar
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const db = makeDb(clientQuery);

    const res = await request(makeApp(db))
      .post("/v1/admin/avatar/configs/default-1/adopt")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("adopted-1");
    expect(res.body.tenant_id).toBe("tenant-a");
    expect(res.body.is_active).toBe(true);
    expect(res.body.is_default).toBe(false);

    const calls = clientQuery.mock.calls as Array<[string, ...unknown[]]>;
    const insertCall = calls.find(
      ([sql]) => typeof sql === "string" && /INSERT INTO avatar_configs/i.test(sql)
    );
    expect(insertCall).toBeDefined();
    const [insertSql, insertParams] = insertCall as [string, unknown[]];

    // lemonslice_agent_id はテナント単位の設定であり複製先の列に混入しない
    expect(insertSql).not.toMatch(/lemonslice_agent_id/);
    // is_default / is_active は固定リテラルで書かれ、複製元から引き継がない
    expect(insertSql).toMatch(/is_default,\s*is_active/);
    expect(insertSql).toMatch(/false,\s*true\)/);
    // 複製する列のみを自テナントの値としてバインドしている
    expect(insertParams[0]).toBe("tenant-a");
    expect(insertParams).toContain(SOURCE_ROW.name);
    expect(insertParams).toContain(SOURCE_ROW.image_url);
    expect(insertParams).toContain(SOURCE_ROW.voice_id);
    expect(insertParams).toContain(SOURCE_ROW.personality_prompt);
    expect(insertParams).toContain(SOURCE_ROW.agent_prompt);
    expect(insertParams).toContain(SOURCE_ROW.agent_idle_prompt);
    expect(insertParams).toContain(SOURCE_ROW.behavior_description);
    expect(insertParams).toContain(SOURCE_ROW.avatar_provider);
  });

  it("同テナントの既存アバターを全て is_active=false にしてから複製を有効化する", async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [SOURCE_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ADOPTED_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const db = makeDb(clientQuery);

    const res = await request(makeApp(db))
      .post("/v1/admin/avatar/configs/default-1/adopt")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);

    const calls = clientQuery.mock.calls as Array<[string, ...unknown[]]>;
    const deactivateAll = calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        /UPDATE avatar_configs SET is_active = false WHERE tenant_id/i.test(sql)
    );
    expect(deactivateAll).toBeDefined();
    expect(deactivateAll![1]).toEqual(["tenant-a"]);
  });

  it("r2c_default 所有の複製元行は一切 UPDATE / DELETE されない", async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [SOURCE_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ADOPTED_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const db = makeDb(clientQuery);

    await request(makeApp(db))
      .post("/v1/admin/avatar/configs/default-1/adopt")
      .set("Authorization", "Bearer dummy");

    const calls = clientQuery.mock.calls as Array<[string, ...unknown[]]>;
    const avatarConfigWrites = calls.filter(
      ([sql]) =>
        typeof sql === "string" &&
        /^(UPDATE|DELETE)\s+avatar_configs/i.test(sql.trim())
    );
    // avatar_configs への書き込みは「同テナントの全deactivate」のみ（対象=tenant-a）。
    // r2c_default 所有の複製元は SELECT のみで一度も書き込まれていないことを保証する。
    expect(avatarConfigWrites).toHaveLength(1);
    expect(avatarConfigWrites[0]![1]).toEqual(["tenant-a"]);
  });

  it("対象が is_default でない、または r2c_default 所有でない場合は 404", async () => {
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // 複製元 SELECT → 該当なし
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const db = makeDb(clientQuery);

    const res = await request(makeApp(db))
      .post("/v1/admin/avatar/configs/not-a-default/adopt")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(404);

    const calls = clientQuery.mock.calls as Array<[string, ...unknown[]]>;
    const insertCall = calls.find(
      ([sql]) => typeof sql === "string" && /INSERT INTO avatar_configs/i.test(sql)
    );
    expect(insertCall).toBeUndefined();
  });

  it("standardプランで成功する", async () => {
    mockQueryTenantPlan.mockResolvedValueOnce("standard");

    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [SOURCE_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ADOPTED_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const db = makeDb(clientQuery);

    const res = await request(makeApp(db))
      .post("/v1/admin/avatar/configs/default-1/adopt")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
  });

  it("starterプランのclient_adminは403で弾かれ、DBへ一切書き込まない", async () => {
    mockQueryTenantPlan.mockResolvedValueOnce("starter");

    const clientQuery = jest.fn(); // 呼ばれてはいけない
    const db = makeDb(clientQuery);

    const res = await request(makeApp(db))
      .post("/v1/admin/avatar/configs/default-1/adopt")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    const writeCalls = clientQuery.mock.calls.filter(
      ([sql]) => typeof sql === "string" && /UPDATE|DELETE|INSERT/i.test(sql)
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("super_adminは?tenant=で代行テナントを指定でき、プラン制限をバイパスする", async () => {
    mockQueryTenantPlan.mockClear();
    mockQueryTenantPlan.mockResolvedValueOnce("starter"); // 呼ばれれば starter で弾かれるはずの値

    const adoptedForOther = { ...ADOPTED_ROW, tenant_id: "tenant-b" };
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [SOURCE_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [adoptedForOther], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const db = makeDb(clientQuery);

    const res = await request(makeApp(db, "super_admin"))
      .post("/v1/admin/avatar/configs/default-1/adopt?tenant=tenant-b")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe("tenant-b");
    expect(mockQueryTenantPlan).not.toHaveBeenCalled();

    const calls = clientQuery.mock.calls as Array<[string, ...unknown[]]>;
    const deactivateAll = calls.find(
      ([sql]) =>
        typeof sql === "string" &&
        /UPDATE avatar_configs SET is_active = false WHERE tenant_id/i.test(sql)
    );
    expect(deactivateAll![1]).toEqual(["tenant-b"]);
  });
});
