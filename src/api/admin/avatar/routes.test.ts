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

// 既定は null（＝ストレージ無効。多くの既存テストはこれで image_url をそのまま扱う）。
// 保存先パスを検証する describe だけが mockSupabaseAdmin.current を差し替える
// （falGenerationRoutes.test.ts の「Supabase Storage の保存先」describe、#682と同じパターン）。
const mockSupabaseAdmin: { current: unknown } = { current: null };
jest.mock("../../../auth/supabaseClient", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.current;
  },
}));

const mockTenantHasFeature = jest.fn().mockResolvedValue(true);
// queryTenantPlan の既定は "growth"（avatar機能あり）。プラン制限テストのみ個別に上書きする。
const mockQueryTenantPlan = jest.fn().mockResolvedValue("growth");
jest.mock("../../../lib/billing/planFeatures", () => {
  const actual = jest.requireActual("../../../lib/billing/planFeatures");
  return {
    tenantHasFeature: (...args: any[]) => mockTenantHasFeature(...args),
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

  it("starterプランのclient_adminは403で弾かれ、DBへ一切書き込まない（旧UIの取りこぼし修正）", async () => {
    mockQueryTenantPlan.mockResolvedValueOnce("starter");

    const clientQuery = jest.fn(); // 呼ばれてはいけない
    const db = {
      connect: jest.fn().mockResolvedValue({
        query: clientQuery,
        release: jest.fn(),
      }),
    };

    const res = await request(makeApp(db, "client_admin"))
      .post("/v1/admin/avatar/configs/config-1/activate")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    // BEGIN すら発行されていないこと（プラン判定はトランザクション開始直後・破壊的操作の前）
    const writeCalls = clientQuery.mock.calls.filter(
      ([sql]) => typeof sql === "string" && /UPDATE|DELETE|INSERT/i.test(sql)
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("super_adminはプラン制限をバイパスする（queryTenantPlanが呼ばれない）", async () => {
    // 他テストの呼び出し履歴が残っているため、このテスト内の呼び出し有無だけを見る
    mockQueryTenantPlan.mockClear();
    mockQueryTenantPlan.mockResolvedValueOnce("starter"); // 呼ばれれば starter で弾かれるはずの値

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

    const res = await request(makeApp(db, "super_admin"))
      .post("/v1/admin/avatar/configs/config-1/activate")
      .set("Authorization", "Bearer dummy");

    expect(res.status).toBe(200);
    expect(mockQueryTenantPlan).not.toHaveBeenCalled();
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

// GID: voice-clone / adopt-designed-voice はいずれも adoptVoiceForConfig() 経由で
// db.connect() によるトランザクション(BEGIN → SET LOCAL lock_timeout → SELECT...FOR UPDATE
// → [Fish呼び出し] → UPDATE → COMMIT)を使う(activateエンドポイントと同じ確立済みパターン)。
// このヘルパーはそのクエリ列を組み立てる。
function makeTxDb(clientQueryImpl: (sql: string, values?: unknown[]) => Promise<any>) {
  const clientQuery = jest.fn(clientQueryImpl);
  const release = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query: clientQuery, release });
  return { db: { connect }, clientQuery, release };
}

// SELECT...FOR UPDATE → 成功 → UPDATE成功、という一番よくある成功シーケンスを
// 組み立てる。個々のテストは必要な箇所だけ上書きする。
function successTxQueries(opts: { checkRow: { id: string }; updateRowCount?: number }) {
  let call = 0;
  return async (sql: string) => {
    call += 1;
    if (sql === "BEGIN" || sql === "SET LOCAL lock_timeout = '3s'" || sql === "COMMIT") return { rows: [] };
    if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [opts.checkRow] };
    if (sql.startsWith("UPDATE avatar_configs SET voice_id")) {
      return { rows: [], rowCount: opts.updateRowCount ?? 1 };
    }
    throw new Error(`unexpected query in test (call ${call}): ${sql}`);
  };
}

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
    mockTenantHasFeature.mockReset().mockResolvedValue(true);
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
    const { db, clientQuery, release } = makeTxDb(
      successTxQueries({ checkRow: { id: "config-1" } }),
    );

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
    // GID 1217084551565350: train_mode は公式Fish Audio APIの必須フィールド。
    // 欠落すると422("train_mode: Field required")で常に失敗することを実APIで確認済み。
    expect(fd.get("train_mode")).toBe("fast");
    expect(fd.get("title")).toBe("マイボイス");
    expect(fd.get("voices")).toBeTruthy();

    // トランザクション: BEGIN → lock_timeout → SELECT FOR UPDATE(tenantスコープ付) →
    // UPDATE(tenantスコープ付) → COMMIT
    const calls = clientQuery.mock.calls as Array<[string, unknown[]?]>;
    expect(calls[0]![0]).toBe("BEGIN");
    expect(calls[1]![0]).toBe("SET LOCAL lock_timeout = '3s'");
    expect(calls[2]![0]).toContain("FOR UPDATE");
    expect(calls[2]![0]).toContain("tenant_id = $2");
    expect(calls[2]![1]).toEqual(["config-1", "tenant-a"]);
    expect(calls[3]![0]).toContain("UPDATE avatar_configs SET voice_id = $1");
    expect(calls[3]![0]).toContain("updated_at = NOW()");
    expect(calls[3]![0]).toContain("tenant_id = $3");
    expect(calls[3]![1]).toEqual(["fish-voice-123", "config-1", "tenant-a"]);
    expect(calls[4]![0]).toBe("COMMIT");
    // ロックしたコネクションを必ず解放している(コネクションプール枯渇の防止)
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("認証エラー: role なし → 403、DB・fetch に到達しない", async () => {
    const { db, clientQuery } = makeTxDb(async () => ({ rows: [] }));

    const res = await request(makeAppNoRole(db))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AUTHZ_ROLE_DENIED");
    expect(clientQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("バリデーション: audio ファイルなし → 400、DB・fetch に到達しない", async () => {
    const { db, clientQuery } = makeTxDb(async () => ({ rows: [] }));

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス");

    expect(res.status).toBe(400);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("バリデーション: name が 101 字 → 400", async () => {
    const { db, clientQuery } = makeTxDb(async () => ({ rows: [] }));

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "あ".repeat(101))
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(clientQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("バリデーション: 許可外 MIME タイプ → 400、fetch に到達しない", async () => {
    const { db } = makeTxDb(async () => ({ rows: [] }));

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
    const { db } = makeTxDb(successTxQueries({ checkRow: { id: "config-1" } }));

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

  it("テナント越境: 他テナント configId → 404、Fish Audio に到達しない・ROLLBACKする", async () => {
    const { db, clientQuery } = makeTxDb(async (sql) => {
      if (sql === "BEGIN" || sql === "SET LOCAL lock_timeout = '3s'" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [] }; // 所有チェック 0件
      throw new Error(`unexpected query: ${sql}`);
    });

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/other-tenant-config/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    // UPDATE は呼ばれず、ROLLBACKで確定する（BEGIN, lock_timeout, SELECT, ROLLBACK の4回）
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(clientQuery.mock.calls[3]![0]).toBe("ROLLBACK");
  });

  it("super_admin は他テナント config も操作可（tenant スコープなし — PATCH と同規則）", async () => {
    const { db, clientQuery } = makeTxDb(successTxQueries({ checkRow: { id: "config-x" } }));

    const res = await request(makeApp(db, "super_admin", ""))
      .post("/v1/admin/avatar/configs/config-x/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(200);
    const calls = clientQuery.mock.calls as Array<[string, unknown[]?]>;
    expect(calls[2]![0]).not.toContain("tenant_id"); // SELECT
    expect(calls[3]![0]).not.toContain("tenant_id"); // UPDATE
  });

  it("plan制限(GID: LP料金表 Enterprise〜): client_adminがvoice_clone不可プランだと403、DB所有チェックにも到達しない", async () => {
    mockTenantHasFeature.mockResolvedValueOnce(false);
    const { db, clientQuery } = makeTxDb(async () => ({ rows: [] }));

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(clientQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockTenantHasFeature).toHaveBeenCalledWith("tenant-a", "voice_clone");
  });

  it("super_adminはplan制限をバイパスする(tenantHasFeatureは呼ばれない)", async () => {
    mockTenantHasFeature.mockResolvedValueOnce(false);
    const { db } = makeTxDb(successTxQueries({ checkRow: { id: "config-x" } }));

    const res = await request(makeApp(db, "super_admin", ""))
      .post("/v1/admin/avatar/configs/config-x/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(200);
    expect(mockTenantHasFeature).not.toHaveBeenCalled();
  });

  it("Fish Audio エラー: ok=false → 502、DB UPDATE に到達しない・外部エラー本文を返さない・ROLLBACKする", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal fish error detail",
      json: async () => ({}),
    } as any);

    const { db, clientQuery } = makeTxDb(async (sql) => {
      if (sql === "BEGIN" || sql === "SET LOCAL lock_timeout = '3s'" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [{ id: "config-1" }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("internal fish error detail");
    // UPDATE は実行されず、ROLLBACKで確定する
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(clientQuery.mock.calls[3]![0]).toBe("ROLLBACK");
  });

  it("FISH_AUDIO_API_KEY 未設定 → 503、DB・fetch に到達しない", async () => {
    delete process.env.FISH_AUDIO_API_KEY;
    const { db, clientQuery } = makeTxDb(async () => ({ rows: [] }));

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(503);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // GID: 二重クリック・複数タブでの同時リクエストを想定した回帰テスト。
  // SELECT...FOR UPDATE のロック待ちが解決できない場合(=同時に別リクエストが
  // 同じconfigを処理中)、Fishへ二重課金せず409で確定することを固定する。
  it("イレギュラー: 同時に別リクエストが同じconfigをロック中(lock timeout)は409で確定し、Fishを呼ばない", async () => {
    const { db, clientQuery } = makeTxDb(async (sql) => {
      if (sql === "BEGIN" || sql === "SET LOCAL lock_timeout = '3s'") return { rows: [] };
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) {
        // pg が lock_timeout 超過時に投げるエラーを再現
        const err = new Error('canceling statement due to lock timeout');
        throw err;
      }
      if (sql === "ROLLBACK") return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/voice-clone")
      .field("name", "マイボイス")
      .attach("audio", AUDIO_BUFFER, {
        filename: "voice.mp3",
        contentType: "audio/mpeg",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("別の操作");
    // ロック待ちで失敗しているため、Fish Audioへは一切到達しない(二重課金防止の核心)
    expect(fetchSpy).not.toHaveBeenCalled();
    const calls = clientQuery.mock.calls as Array<[string, unknown[]?]>;
    expect(calls[calls.length - 1]![0]).toBe("ROLLBACK");
  });
});

// --------------------------------------------------------------------------
// GID 1217084040137242: POST /v1/admin/avatar/configs/:id/adopt-designed-voice
// design-voice が返した候補音声(WAV)を永続音声モデルとして採用する。
// voice-clone と同じ Fish /model 作成 + tenant スコープ規則 + トランザクション
// (adoptVoiceForConfig 経由)を共有するため、権限境界(client_admin/super_admin)の
// テストを中心に、実装差分（multipart化・train_mode）を検証する。
// --------------------------------------------------------------------------
describe("POST /v1/admin/avatar/configs/:id/adopt-designed-voice", () => {
  const CANDIDATE_AUDIO = Buffer.from("fake-wav-candidate-bytes");
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.FISH_AUDIO_API_KEY = "test-fish-key";
    mockTenantHasFeature.mockReset().mockResolvedValue(true);
    fetchSpy = jest.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ _id: "fish-voice-designed-123" }),
      text: async () => "",
    } as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.FISH_AUDIO_API_KEY;
  });

  it("正常系: client_admin + 自テナント config → Fish Audio呼び出し(train_mode=fast) + voice_id UPDATE + 200", async () => {
    const { db, clientQuery } = makeTxDb(successTxQueries({ checkRow: { id: "config-1" } }));

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/adopt-designed-voice")
      .field("name", "設計した声")
      .attach("audio", CANDIDATE_AUDIO, { filename: "candidate.wav", contentType: "audio/wav" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ voiceId: "fish-voice-designed-123" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.fish.audio/model");
    const fd = init.body as FormData;
    expect(fd.get("train_mode")).toBe("fast");
    expect(fd.get("title")).toBe("設計した声");

    const calls = clientQuery.mock.calls as Array<[string, unknown[]?]>;
    expect(calls[3]![0]).toContain("UPDATE avatar_configs SET voice_id = $1");
    expect(calls[3]![0]).toContain("tenant_id = $3");
    expect(calls[3]![1]).toEqual(["fish-voice-designed-123", "config-1", "tenant-a"]);
    expect(calls[4]![0]).toBe("COMMIT");
  });

  it("テナント越境: 他テナント configId → 404、Fish Audioに到達しない", async () => {
    const { db } = makeTxDb(async (sql) => {
      if (sql === "BEGIN" || sql === "SET LOCAL lock_timeout = '3s'" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/other-tenant-config/adopt-designed-voice")
      .field("name", "設計した声")
      .attach("audio", CANDIDATE_AUDIO, { filename: "candidate.wav", contentType: "audio/wav" });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("super_admin は他テナント config も操作可（tenant スコープなし — voice-clone と同規則）", async () => {
    const { db, clientQuery } = makeTxDb(successTxQueries({ checkRow: { id: "config-x" } }));

    const res = await request(makeApp(db, "super_admin", ""))
      .post("/v1/admin/avatar/configs/config-x/adopt-designed-voice")
      .field("name", "設計した声")
      .attach("audio", CANDIDATE_AUDIO, { filename: "candidate.wav", contentType: "audio/wav" });

    expect(res.status).toBe(200);
    expect(clientQuery.mock.calls[2]![0]).not.toContain("tenant_id");
  });

  it("previewMode相当: super_adminが空テナントで他テナントconfigを操作しても越境しない(super_adminスコープ確認)", async () => {
    const { db } = makeTxDb(successTxQueries({ checkRow: { id: "config-y" } }));

    const res = await request(makeApp(db, "super_admin", "carnation-demo"))
      .post("/v1/admin/avatar/configs/config-y/adopt-designed-voice")
      .field("name", "設計した声")
      .attach("audio", CANDIDATE_AUDIO, { filename: "candidate.wav", contentType: "audio/wav" });

    expect(res.status).toBe(200);
  });

  it("plan制限: client_adminがvoice_clone不可プランだと403、DB所有チェックにも到達しない", async () => {
    mockTenantHasFeature.mockResolvedValueOnce(false);
    const { db, clientQuery } = makeTxDb(async () => ({ rows: [] }));

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/adopt-designed-voice")
      .field("name", "設計した声")
      .attach("audio", CANDIDATE_AUDIO, { filename: "candidate.wav", contentType: "audio/wav" });

    expect(res.status).toBe(403);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Fish Audio エラー: ok=false → 502、DB UPDATEに到達しない・外部エラー本文を返さない", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal fish error detail",
    } as any);
    const { db, clientQuery } = makeTxDb(async (sql) => {
      if (sql === "BEGIN" || sql === "SET LOCAL lock_timeout = '3s'" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [{ id: "config-1" }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/adopt-designed-voice")
      .field("name", "設計した声")
      .attach("audio", CANDIDATE_AUDIO, { filename: "candidate.wav", contentType: "audio/wav" });

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("internal fish error detail");
    expect(clientQuery.mock.calls[clientQuery.mock.calls.length - 1]![0]).toBe("ROLLBACK");
  });

  it("音声ファイル未添付は400、Fish Audioに到達しない", async () => {
    const { db, clientQuery } = makeTxDb(async () => ({ rows: [] }));

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/adopt-designed-voice")
      .field("name", "設計した声");

    expect(res.status).toBe(400);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // GID: adopt-designed-voiceはdesign-voiceの候補採用という性質上、同一候補に対して
  // 連打・複数タブでの同時採用が起きやすい。voice-cloneと同じ二重課金防止を確認する。
  it("イレギュラー: 同時に別リクエストが同じconfigをロック中(lock timeout)は409で確定し、Fishを呼ばない", async () => {
    const { db } = makeTxDb(async (sql) => {
      if (sql === "BEGIN" || sql === "SET LOCAL lock_timeout = '3s'") return { rows: [] };
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) {
        throw new Error('canceling statement due to lock timeout');
      }
      if (sql === "ROLLBACK") return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .post("/v1/admin/avatar/configs/config-1/adopt-designed-voice")
      .field("name", "設計した声")
      .attach("audio", CANDIDATE_AUDIO, { filename: "candidate.wav", contentType: "audio/wav" });

    expect(res.status).toBe(409);
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

// --------------------------------------------------------------------------
// PATCH /v1/admin/avatar/configs/:id — base64画像アップロードの保存先(#P1-A)
// --------------------------------------------------------------------------
// このエンドポイントには元々テストが1件も無かった。super_adminのpreviewMode中に
// ?tenant= を無視して生の(空の)tenantIdでバケット直下に保存していた欠陥
// (POSTは effectiveTenantId を使うのに、同一ファイル内のPATCHだけ生のtenantIdを
// 使っていた非対称)を固定する。

const DATA_URL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("PATCH /v1/admin/avatar/configs/:id — 画像アップロードの保存先", () => {
  const uploadedPaths: string[] = [];

  function makeStorageAdmin() {
    uploadedPaths.length = 0;
    return {
      storage: {
        createBucket: () => Promise.resolve({ error: null }),
        from: () => ({
          upload: (filePath: string) => {
            uploadedPaths.push(filePath);
            return Promise.resolve({ error: null });
          },
          getPublicUrl: (filePath: string) => ({
            data: { publicUrl: `https://cdn.example/${filePath}` },
          }),
        }),
      },
    };
  }

  beforeEach(() => {
    mockSupabaseAdmin.current = makeStorageAdmin();
  });

  afterEach(() => {
    // 他のdescribe(ストレージ無効前提)へ影響を残さない
    mockSupabaseAdmin.current = null;
  });

  it("super_admin + ?tenant=tenant-b → 保存パスが tenant-b/ で始まる", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ is_default: false }] }) // is_default チェック
      .mockResolvedValueOnce({ rows: [{ ...CONFIG_ROW, id: "config-1" }] }); // UPDATE ... RETURNING

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin", ""))
      .patch("/v1/admin/avatar/configs/config-1?tenant=tenant-b")
      .send({ image_url: DATA_URL_PNG });

    expect(res.status).toBe(200);
    expect(uploadedPaths).toHaveLength(1);
    expect(uploadedPaths[0]!.startsWith("tenant-b/")).toBe(true);
  });

  it("super_admin で ?tenant= なし → 400でテナント不明として止まり、バケット直下へ一切書き込まない", async () => {
    // is_default チェックの1回のみ発行され、UPDATEには到達しない
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ is_default: false }] });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin", ""))
      .patch("/v1/admin/avatar/configs/config-1")
      .send({ image_url: DATA_URL_PNG });

    // 今回の欠陥そのものの回帰ガード: 修正前は空テナントのまま
    // "/avatar-xxx.png" というバケット直下パスで実際に書き込まれていた
    expect(res.status).toBe(400);
    expect(uploadedPaths).toHaveLength(0);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("[越権防止] client_adminが?tenant=tenant-bを付けても自テナント配下になる", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ is_default: false }] })
      .mockResolvedValueOnce({ rows: [{ ...CONFIG_ROW, id: "config-1" }] });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "client_admin", "tenant-a"))
      .patch("/v1/admin/avatar/configs/config-1?tenant=tenant-b")
      .send({ image_url: DATA_URL_PNG });

    expect(res.status).toBe(200);
    expect(uploadedPaths).toHaveLength(1);
    expect(uploadedPaths[0]!.startsWith("tenant-a/")).toBe(true);
  });

  it("base64でない(https URL)場合はStorageを一切触らない(チャットUI採用経路の回帰ガード)", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ is_default: false }] })
      .mockResolvedValueOnce({ rows: [{ ...CONFIG_ROW, id: "config-1" }] });

    const db = { query: dbQuery };

    const res = await request(makeApp(db, "super_admin", ""))
      .patch("/v1/admin/avatar/configs/config-1?tenant=tenant-b")
      .send({ image_url: "https://img.example/already-hosted.png" });

    expect(res.status).toBe(200);
    expect(uploadedPaths).toHaveLength(0);
  });

  it("PATCHのSQL挙動(super_adminの跨テナント更新可)は変えない — WHERE句にtenant_id条件が付かない", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ is_default: false }] })
      .mockResolvedValueOnce({ rows: [{ ...CONFIG_ROW, id: "config-1" }] });

    const db = { query: dbQuery };

    await request(makeApp(db, "super_admin", ""))
      .patch("/v1/admin/avatar/configs/config-1?tenant=tenant-b")
      .send({ image_url: DATA_URL_PNG });

    const updateCall = dbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.startsWith("UPDATE avatar_configs"),
    );
    expect(updateCall![0]).not.toContain("tenant_id");
  });
});
