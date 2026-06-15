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

// --------------------------------------------------------------------------
// POST /v1/admin/avatar/configs — emotion_tags バリデーション（Phase47-A 構文保護）
// --------------------------------------------------------------------------

describe("POST /v1/admin/avatar/configs — emotion_tags validation", () => {
  it("emotion_tags に [ ] を含むタグがあると 400 を返す", async () => {
    const db = { query: jest.fn() };
    const app = makeApp(db, "client_admin");

    const res = await request(app)
      .post("/v1/admin/avatar/configs")
      .send({ name: "テスト", emotion_tags: ["happy", "[injection]"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("emotion_tags が通常の英単語/日本語タグなら schema を通過する", async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ ...CONFIG_ROW, is_active: false }] }),
    };
    const app = makeApp(db, "client_admin");

    const res = await request(app)
      .post("/v1/admin/avatar/configs")
      .send({ name: "テスト", emotion_tags: ["happy", "落ち着き"] });

    expect(res.status).not.toBe(400);
  });
});

// --------------------------------------------------------------------------
// POST /v1/admin/avatar/configs/:id/voice-clone — FishAudio Phase B-2
// --------------------------------------------------------------------------

describe("POST /v1/admin/avatar/configs/:id/voice-clone", () => {
  const AUDIO_BUFFER = Buffer.from("dummy-audio-bytes");
  let fetchSpy: jest.SpyInstance;

  // makeApp で role なしユーザーを再現するためのバリアント
  function makeAppNoRole(db: any) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.supabaseUser = { app_metadata: {} };
      next();
    });
    registerAvatarConfigRoutes(app, db);
    return app;
  }

  beforeEach(() => {
    process.env.FISH_AUDIO_API_KEY = "test-fish-key";
    fetchSpy = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ _id: "fish-voice-123" }),
      text: async () => "",
    } as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.FISH_AUDIO_API_KEY;
  });

  it("正常系: client_admin + 自テナント config → Fish Audio 呼び出し + voice_id UPDATE + 200", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "config-1" }] })   // 所有チェック SELECT
      .mockResolvedValueOnce({ rows: [{ id: "config-1" }] });  // UPDATE RETURNING id

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ voiceId: "fish-voice-123" });

    // Fish Audio へ FormData で POST されている
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.fish.audio/model");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get("visibility")).toBe("private");
    expect(fd.get("type")).toBe("tts");
    expect(fd.get("title")).toBe("マイボイス");
    expect(fd.get("voices")).toBeTruthy();

    // 所有チェック + UPDATE の両方が tenant スコープ付き
    const [checkSql, checkParams] = dbQuery.mock.calls[0] as [string, unknown[]];
    expect(checkSql).toContain("tenant_id = $2");
    expect(checkParams).toEqual(["config-1", "tenant-a"]);

    const [updateSql, updateParams] = dbQuery.mock.calls[1] as [string, unknown[]];
    expect(updateSql).toContain("UPDATE avatar_configs SET voice_id = $1");
    expect(updateSql).toContain("updated_at = NOW()");
    expect(updateSql).toContain("tenant_id = $3");
    expect(updateParams).toEqual(["fish-voice-123", "config-1", "tenant-a"]);
  });

  it("認証エラー: role なし → 403、DB・fetch に到達しない", async () => {
    const dbQuery = jest.fn();
    const db = { query: dbQuery };

    const res = await request(makeAppNoRole(db))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AUTHZ_ROLE_DENIED");
    expect(dbQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("バリデーション: audio ファイルなし → 400、DB・fetch に到達しない", async () => {
    const dbQuery = jest.fn();
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス");

    expect(res.status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("バリデーション: name が 101 字 → 400", async () => {
    const dbQuery = jest.fn();
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "あ".repeat(101))
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(dbQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("バリデーション: 許可外 MIME タイプ → 400、fetch に到達しない", async () => {
    const dbQuery = jest.fn();
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "evil.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("回帰: audio/x-m4a (.m4a macOS Chrome) → Fish Audio 呼び出し + 200", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "config-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "config-1" }] });
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "m4aボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.m4a",
        contentType: "audio/x-m4a",
      });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("テナント越境: 他テナント configId → 404、Fish Audio に到達しない", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }); // 所有チェック SELECT → 0 件

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/other-tenant-config/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    // UPDATE は呼ばれない（SELECT のみ）
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("super_admin は他テナント config も操作可（tenant スコープなし — PATCH と同規則）", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "config-x" }] })
      .mockResolvedValueOnce({ rows: [{ id: "config-x" }] });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin", ""))
      .post("/v1/admin/avatar/configs/config-x/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(200);
    const [checkSql] = dbQuery.mock.calls[0] as [string, unknown[]];
    expect(checkSql).not.toContain("tenant_id");
    const [updateSql] = dbQuery.mock.calls[1] as [string, unknown[]];
    expect(updateSql).not.toContain("tenant_id");
  });

  it("Fish Audio エラー: ok=false → 502、DB UPDATE に到達しない・外部エラー本文を返さない", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal fish error detail",
      json: async () => ({}),
    } as any);

    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "config-1" }] }); // 所有チェックは通る

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("internal fish error detail");
    // UPDATE は実行されない（SELECT のみ）
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("FISH_AUDIO_API_KEY 未設定 → 503、DB・fetch に到達しない", async () => {
    delete process.env.FISH_AUDIO_API_KEY;
    const dbQuery = jest.fn();
    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(503);
    expect(dbQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// resizeForLemonSlice — I-6 カスタム画像の 368x560 リサイズ
// --------------------------------------------------------------------------

describe("resizeForLemonSlice (I-6)", () => {
  it("1024x1024 画像が 368x560 にリサイズされる", async () => {
    const { resizeForLemonSlice } = await import("./routes");
    const { default: sharp } = await import("sharp");

    const src = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const out = await resizeForLemonSlice(src);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(368);
    expect(meta.height).toBe(560);
  });

  it("画像でないバッファは元のまま返す（アップロード継続のフォールバック）", async () => {
    const { resizeForLemonSlice } = await import("./routes");
    const junk = Buffer.from("not-an-image");
    const out = await resizeForLemonSlice(junk);
    expect(out).toBe(junk);
  });
});
