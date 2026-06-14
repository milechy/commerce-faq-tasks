// src/api/avatar/livekitTokenRoutes.test.ts
// livekitTokenRoutes POST /api/avatar/room-token のアバター設定取得クエリ検証
//
// 修正内容(Phase66):
//   Q2: OR is_default = true → OR tenant_id = 'r2c_default' (クロステナント誤表示修正)
//   Q3: ORDER BY created_at DESC 追加 (非決定的LIMIT防止)
//
// 修正内容(Path B fix / GID1215114990855142):
//   avatarConfigId を room metadata に埋め込み → agent.py が特定アバターを選択できる

import express from "express";
import request from "supertest";
import { registerLiveKitTokenRoutes } from "./livekitTokenRoutes";

// ── モック ────────────────────────────────────────────────────────────────────

jest.mock("../../lib/db", () => ({
  pool: { query: jest.fn() },
}));
const mockCreateRoom = jest.fn().mockResolvedValue({});
const mockCreateDispatch = jest.fn().mockResolvedValue({ id: "dispatch-1", room: "room-1" });

jest.mock("livekit-server-sdk", () => ({
  RoomServiceClient: jest.fn().mockImplementation(() => ({
    createRoom: mockCreateRoom,
  })),
  AgentDispatchClient: jest.fn().mockImplementation(() => ({
    createDispatch: mockCreateDispatch,
  })),
}));

import { pool } from "../../lib/db";
const mockQuery = pool!.query as jest.Mock;

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function makeApp(tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantId = tenantId;
    next();
  });
  const apiStack: any[] = [];
  registerLiveKitTokenRoutes(app, apiStack);
  return app;
}

const TENANT_ROW = {
  features: { avatar: true, voice: false, rag: false },
  lemonslice_agent_id: "agent_abc123",
  is_active: true,
};

const LIVEKIT_ENV = {
  LIVEKIT_URL: "wss://test.livekit.cloud",
  LIVEKIT_API_KEY: "test-api-key",
  LIVEKIT_API_SECRET: "test-api-secret",
};

// ── テスト ────────────────────────────────────────────────────────────────────

describe("POST /api/avatar/room-token", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    Object.assign(process.env, LIVEKIT_ENV);
    mockQuery.mockReset();
    mockCreateRoom.mockReset().mockResolvedValue({});
    mockCreateDispatch.mockReset().mockResolvedValue({ id: "dispatch-1", room: "room-1" });
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ── 有効な UUID テストフィクスチャ (strict UUID validation 対応) ──
  const UUID_SAM       = "87ca75df-8fd5-4e41-b3e4-1cbdc2d97462";
  const UUID_DEFAULT   = "d0d3722c-e033-4d91-8eb2-66a06978548a";
  const UUID_OTHER     = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  describe("avatarConfigId 指定時 (Q2)", () => {
    it("同テナントの avatarConfigId を指定すると image_url/name を返す", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })  // tenants SELECT
        .mockResolvedValueOnce({                                       // avatar_configs Q2
          rows: [{ image_url: "https://example.com/img.png", name: "Haruka" }],
        });

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: UUID_SAM });

      expect(res.body.enabled).toBe(true);
      expect(res.body.imageUrl).toBe("https://example.com/img.png");
      expect(res.body.avatarName).toBe("Haruka");

      // Q2クエリが r2c_default 条件 + is_active 必須を含むことを検証
      const q2Call = mockQuery.mock.calls[1];
      const sql: string = q2Call[0];
      expect(sql).toContain("tenant_id = 'r2c_default'");
      expect(sql).toContain("is_active = true");
      expect(sql).not.toContain("is_default = true");
    });

    it("r2c_default のアバター (is_default=true 移行済み) を別テナントから取得できる", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ image_url: "https://example.com/default.png", name: "SAM" }],
        });

      const app = makeApp("other-tenant");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: UUID_DEFAULT });

      expect(res.body.enabled).toBe(true);
      expect(res.body.avatarName).toBe("SAM");
    });

    it("他テナントかつ r2c_default でもない avatarConfigId は取得できない", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] }); // 0件: 別テナントの非デフォルトアバター

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: UUID_OTHER });

      expect(res.body.enabled).toBe(true);
      expect(res.body.imageUrl).toBeNull();
      expect(res.body.avatarName).toBeNull();

      // Q2 SQL が tenant_id 制約で他テナントを排除していることを検証
      // (mockPool([]) の決め打ちではなく、WHERE句が実際に組み込まれていることを確認)
      const q2Call = mockQuery.mock.calls[1];
      const sql: string = q2Call[0];
      const params: unknown[] = q2Call[1];
      expect(sql).toContain("tenant_id = $2");
      expect(sql).toContain("tenant_id = 'r2c_default'");
      expect(sql).toContain("is_active = true");
      expect(params[0]).toBe(UUID_OTHER);                 // $1 = avatarConfigId
      expect(params[1]).toBe("tenant-a");                 // $2 = requestingTenantId (排除の主体)
    });

    it("inactive な自テナント avatarConfigId は is_active=true 制約で 0件 (Codex MEDIUM #210)", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] }); // 0件: 無効化済み config は復活させない

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: UUID_SAM, connect: true });

      expect(res.body.enabled).toBe(true);
      expect(res.body.imageUrl).toBeNull();
      expect(res.body.avatarName).toBeNull();

      // Q2 SQL に is_active = true が含まれることを検証
      const q2Call = mockQuery.mock.calls[1];
      const sql: string = q2Call[0];
      expect(sql).toContain("is_active = true");

      // 無効化済み config は room metadata にも伝搬しない (verifiedAvatarConfigId = null)
      expect(mockCreateRoom).toHaveBeenCalledTimes(1);
      const createRoomArg = mockCreateRoom.mock.calls[0][0] as { metadata?: string };
      expect(createRoomArg.metadata).toBeUndefined();
    });
  });

  describe("UUID validation (Codex LOW #210)", () => {
    it("不正な avatarConfigId (非UUID文字列) は 400", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 });

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: "not-a-uuid" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/UUID/);
      // DB lookup (Q2/Q3) より前に弾く — tenants SELECT のみで終わる
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("不正な avatarConfigId (number 型) は 400", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 });

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: 12345 });

      expect(res.status).toBe(400);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("avatarConfigId 未指定 (undefined) は素通し (fallback Q3 へ)", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] });

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
    });

    it("avatarConfigId が null は素通し (fallback Q3 へ)", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] });

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: null });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
    });
  });

  describe("avatarConfigId 未指定時 (Q3)", () => {
    it("自テナントの is_active=true アバターを ORDER BY created_at DESC で取得する", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ image_url: "https://example.com/active.png", name: "Rei" }],
        });

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({});

      expect(res.body.enabled).toBe(true);
      expect(res.body.imageUrl).toBe("https://example.com/active.png");

      // Q3クエリが ORDER BY created_at DESC を含むことを検証
      const q3Call = mockQuery.mock.calls[1];
      const sql: string = q3Call[0];
      expect(sql).toContain("ORDER BY created_at DESC");
      expect(sql).toContain("tenant_id = $1");
      expect(sql).toContain("is_active = true");
    });

    it("is_active アバターがない場合は imageUrl=null で enabled=true を返す", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] });

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({});

      expect(res.body.enabled).toBe(true);
      expect(res.body.imageUrl).toBeNull();
    });
  });

  describe("Path B fix: room metadata への avatarConfigId 伝搬", () => {
    it("avatarConfigId 指定時: createRoom が metadata={avatarConfigId} で呼ばれる", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ image_url: "https://example.com/sam.png", name: "SAM" }] });

      const app = makeApp("tenant-a");
      await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: UUID_SAM, connect: true });

      expect(mockCreateRoom).toHaveBeenCalledTimes(1);
      const createRoomArg = mockCreateRoom.mock.calls[0][0] as { metadata?: string };
      expect(createRoomArg.metadata).toBeDefined();
      const meta = JSON.parse(createRoomArg.metadata!);
      expect(meta.avatarConfigId).toBe(UUID_SAM);
    });

    it("avatarConfigId 未指定時: createRoom の metadata は undefined", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] });

      const app = makeApp("tenant-a");
      await request(app)
        .post("/api/avatar/room-token")
        .send({ connect: true });

      expect(mockCreateRoom).toHaveBeenCalledTimes(1);
      const createRoomArg = mockCreateRoom.mock.calls[0][0] as { metadata?: string };
      expect(createRoomArg.metadata).toBeUndefined();
    });

    it("cross-tenant avatarConfigId (Q2=0件): createRoom の metadata は undefined (trust boundary)", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] }); // Q2 0件 = 他テナント非デフォルト → アクセス拒否

      const app = makeApp("tenant-a");
      await request(app)
        .post("/api/avatar/room-token")
        .send({ avatarConfigId: UUID_OTHER, connect: true });

      // Q2 SQL が tenant_id = $2 で tenant-a 以外を排除していることを検証
      const q2Call = mockQuery.mock.calls[1];
      const sql: string = q2Call[0];
      const params: unknown[] = q2Call[1];
      expect(sql).toContain("tenant_id = $2");
      expect(sql).toContain("tenant_id = 'r2c_default'");
      expect(sql).toContain("is_active = true");
      expect(params[0]).toBe(UUID_OTHER);          // $1 = avatarConfigId
      expect(params[1]).toBe("tenant-a");          // $2 = requestingTenantId

      // SQL ownership check が通らなかった UUID は room metadata に載らない
      expect(mockCreateRoom).toHaveBeenCalledTimes(1);
      const createRoomArg = mockCreateRoom.mock.calls[0][0] as { metadata?: string };
      expect(createRoomArg.metadata).toBeUndefined();
    });
  });

  describe("pre_dispatch フラグ分岐", () => {
    it("pre_dispatch=true かつ connect=false → dispatchAgentToRoom が呼ばれ preDispatchEnabled=true", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ ...TENANT_ROW, features: { avatar: true, pre_dispatch: true } }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [] }); // Q3: avatarConfigId 未指定 → fallback

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ connect: false });

      // レスポンス確認
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.preDispatchEnabled).toBe(true);

      // dispatch が呼ばれていることを確認（fire-and-forget のため Promise 解決を待つ）
      await new Promise(resolve => setImmediate(resolve));
      expect(mockCreateDispatch).toHaveBeenCalledTimes(1);
    });

    it("pre_dispatch=false かつ connect=false → dispatch 呼ばれず preDispatchEnabled=false", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ ...TENANT_ROW, features: { avatar: true, pre_dispatch: false } }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [] }); // Q3 fallback

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ connect: false });

      expect(res.status).toBe(200);
      expect(res.body.preDispatchEnabled).toBe(false);

      // dispatch が呼ばれていないことを確認
      await new Promise(resolve => setImmediate(resolve));
      expect(mockCreateDispatch).toHaveBeenCalledTimes(0);
    });

    it("features に pre_dispatch キー無し → dispatch スキップ、preDispatchEnabled=false（コスト発生なし）", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ ...TENANT_ROW, features: { avatar: true } }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [] }); // Q3 fallback

      const app = makeApp("tenant-a");
      const res = await request(app)
        .post("/api/avatar/room-token")
        .send({ connect: false });

      expect(res.status).toBe(200);
      expect(res.body.preDispatchEnabled).toBe(false);

      // pre_dispatch キーが存在しない場合は dispatch を呼ばない（デフォルト安全）
      await new Promise(resolve => setImmediate(resolve));
      expect(mockCreateDispatch).toHaveBeenCalledTimes(0);
    });
  });

  // enabled:false が返る各経路で reason コードが付与されることを検証
  // （テストチャットがこの reason を優しい日本語へ変換して可視化する — サイレントフォールバック解消）
  describe("enabled=false 時の reason コード", () => {
    it("テナントが DB に存在しない → reason=tenant_not_found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(makeApp("tenant-a")).post("/api/avatar/room-token").send({});

      expect(res.body.enabled).toBe(false);
      expect(res.body.reason).toBe("tenant_not_found");
    });

    it("テナントが is_active=false → reason=tenant_inactive", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...TENANT_ROW, is_active: false }], rowCount: 1 });

      const res = await request(makeApp("tenant-a")).post("/api/avatar/room-token").send({});

      expect(res.body.enabled).toBe(false);
      expect(res.body.reason).toBe("tenant_inactive");
    });

    it("avatar 機能が無効 → 403 + reason=avatar_disabled", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...TENANT_ROW, features: { avatar: false } }],
        rowCount: 1,
      });

      const res = await request(makeApp("tenant-a")).post("/api/avatar/room-token").send({});

      expect(res.status).toBe(403);
      expect(res.body.reason).toBe("avatar_disabled");
    });

    it("lemonslice_agent_id 未設定 → reason=agent_not_configured", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...TENANT_ROW, lemonslice_agent_id: null }],
        rowCount: 1,
      });

      const res = await request(makeApp("tenant-a")).post("/api/avatar/room-token").send({});

      expect(res.body.enabled).toBe(false);
      expect(res.body.reason).toBe("agent_not_configured");
    });

    it("LiveKit 環境変数が未設定 → reason=livekit_not_configured", async () => {
      delete process.env.LIVEKIT_URL;
      delete process.env.LIVEKIT_API_KEY;
      delete process.env.LIVEKIT_API_SECRET;
      mockQuery.mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 });

      const res = await request(makeApp("tenant-a")).post("/api/avatar/room-token").send({});

      expect(res.body.enabled).toBe(false);
      expect(res.body.reason).toBe("livekit_not_configured");
    });

    it("DB カラム未マイグレーション (42703) → reason=migration_required", async () => {
      mockQuery.mockRejectedValueOnce(Object.assign(new Error("column missing"), { code: "42703" }));

      const res = await request(makeApp("tenant-a")).post("/api/avatar/room-token").send({});

      expect(res.body.enabled).toBe(false);
      expect(res.body.reason).toBe("migration_required");
    });

    it("正常時は reason を含まず enabled=true を返す（後方互換）", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [TENANT_ROW], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(makeApp("tenant-a")).post("/api/avatar/room-token").send({});

      expect(res.body.enabled).toBe(true);
      expect(res.body.reason).toBeUndefined();
    });
  });
});
