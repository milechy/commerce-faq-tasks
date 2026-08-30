// src/api/internal/avatarConfigRoutes.test.ts
// GET /api/internal/avatar-config の avatarConfigId 伝搬修正(Path B fix)検証
// + 内部API HMAC 認証(P0: 任意 tenantId 指定による他テナント設定漏洩の遮断)

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { createHmac } from "node:crypto";
import { registerInternalAvatarConfigRoutes } from "./avatarConfigRoutes";

jest.mock("../../lib/db", () => ({
  getPool: jest.fn(),
}));

jest.mock("../../lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getPool } from "../../lib/db";
import { logger } from "../../lib/logger";
const mockGetPool = getPool as jest.Mock;

const HMAC_SECRET = "test-internal-hmac-secret";

// GET はボディを持たないため署名対象は空オブジェクト {}（サーバ側 express.json が
// req.body={} にするのと一致）。
function hmacHeaders(secret: string = HMAC_SECRET, ts?: string) {
  const timestamp = ts ?? Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}:${JSON.stringify({})}`)
    .digest("hex");
  return {
    "x-internal-request": "1",
    "x-hmac-timestamp": timestamp,
    "x-hmac-signature": signature,
  };
}

function makeApp() {
  process.env.INTERNAL_API_HMAC_SECRET = HMAC_SECRET;
  const app = express();
  // 本番同様グローバル express.json を通し、GET でも req.body={} になる状態を再現する。
  app.use(express.json());
  registerInternalAvatarConfigRoutes(app);
  return app;
}

/** 正しい HMAC 署名付きの GET。 */
function signedGet(app: express.Express, url: string) {
  return request(app).get(url).set(hmacHeaders());
}

const AVATAR_ROW = {
  voice_id: "voice-123",
  personality_prompt: "You are SAM.",
  emotion_tags: [],
  lemonslice_agent_id: "agent_289feaadc2983989",
  behavior_description: null,
  avatar_provider: "lemonslice",
  image_url: "https://example.com/sam.png",
  agent_prompt: "calm",
  agent_idle_prompt: "idle",
};

const ARJUN_ROW = {
  ...AVATAR_ROW,
  personality_prompt: "You are ARJUN.",
  lemonslice_agent_id: "agent_b039be055ea73c6d",
  image_url: "https://example.com/arjun.png",
};

function mockPool(rows: object[]) {
  const mockQuery = jest.fn().mockResolvedValue({ rows });
  mockGetPool.mockReturnValue({ query: mockQuery });
  return mockQuery;
}

describe("GET /api/internal/avatar-config", () => {
  beforeEach(() => {
    mockGetPool.mockReset();
    (logger.warn as jest.Mock).mockClear();
    process.env.INTERNAL_API_HMAC_SECRET = HMAC_SECRET;
  });
  afterAll(() => {
    delete process.env.INTERNAL_API_HMAC_SECRET;
  });

  describe("fail-closed: X-Internal-Request ヘッダなし → 403", () => {
    it("ヘッダ欠落で 403", async () => {
      const res = await request(makeApp()).get("/api/internal/avatar-config?tenantId=tenant-a");
      expect(res.status).toBe(403);
    });
  });

  describe("tenantId 未指定 → 400", () => {
    it("tenantId なしで 400", async () => {
      const res = await signedGet(makeApp(), "/api/internal/avatar-config");
      expect(res.status).toBe(400);
    });
  });

  const UUID_SAM     = "87ca75df-8fd5-4e41-b3e4-1cbdc2d97462";
  const UUID_DEFAULT = "d0d3722c-e033-4d91-8eb2-66a06978548a";
  const UUID_OTHER   = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  describe("avatarConfigId 指定時 (Path B fix)", () => {
    it("自テナントのアバターを ID 指定で取得できる", async () => {
      const mockQuery = mockPool([AVATAR_ROW]);
      const res = await signedGet(
        makeApp(),
        `/api/internal/avatar-config?tenantId=tenant-a&avatarConfigId=${UUID_SAM}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.config.lemonslice_agent_id).toBe("agent_289feaadc2983989");

      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain("id = $1");
      expect(sql).toContain("tenant_id = $2");
      expect(sql).toContain("tenant_id = 'r2c_default'");
      expect(sql).toContain("is_active = true");  // Codex MEDIUM #210: ID 指定パスも is_active 必須
      expect(mockQuery.mock.calls[0][1]).toEqual([UUID_SAM, "tenant-a"]);
    });

    it("r2c_default のアバターを別テナントから ID 指定で取得できる (cross-tenant)", async () => {
      const mockQuery = mockPool([AVATAR_ROW]);
      const res = await signedGet(
        makeApp(),
        `/api/internal/avatar-config?tenantId=other-tenant&avatarConfigId=${UUID_DEFAULT}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.config).not.toBeNull();

      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain("tenant_id = 'r2c_default'");
    });

    it("他テナント非デフォルトアバターは取得できない — SQL が tenant_id と id の両方でバインドして排除する", async () => {
      const mockQuery = mockPool([]);
      const res = await signedGet(
        makeApp(),
        `/api/internal/avatar-config?tenantId=tenant-a&avatarConfigId=${UUID_OTHER}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.config).toBeNull();

      // WHERE 句と引数バインドを両方確認:
      // DB が 0件を返したのが「UUID_OTHER が tenant-a にも r2c_default にも属さない」
      // という正しいクエリを発行した結果であることを検証する
      const sql: string = mockQuery.mock.calls[0][0];
      const params: unknown[] = mockQuery.mock.calls[0][1];
      expect(sql).toContain("id = $1");
      expect(sql).toContain("tenant_id = $2");
      expect(sql).toContain("tenant_id = 'r2c_default'");
      expect(sql).toContain("is_active = true");
      expect(params).toEqual([UUID_OTHER, "tenant-a"]);
    });

    it("inactive な自テナントアバターは ID 指定でも復活しない (Codex MEDIUM #210)", async () => {
      // 無効化済み config は WHERE id = $1 AND ... AND is_active = true で 0件
      const mockQuery = mockPool([]);
      const res = await signedGet(
        makeApp(),
        `/api/internal/avatar-config?tenantId=tenant-a&avatarConfigId=${UUID_SAM}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.config).toBeNull();

      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain("is_active = true");
      // 注: admin UI の inactive プレビューはこの経路ではなく、認証済み admin 専用経路で対応 (別タスク)
    });
  });

  describe("avatarConfigId 未指定時 (fallback: ORDER BY 決定的)", () => {
    it("is_active アバターを ORDER BY created_at DESC で取得する", async () => {
      const mockQuery = mockPool([ARJUN_ROW]);
      const res = await signedGet(makeApp(), "/api/internal/avatar-config?tenantId=r2c_default");

      expect(res.status).toBe(200);
      expect(res.body.config.lemonslice_agent_id).toBe("agent_b039be055ea73c6d");

      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain("is_active = true");
      expect(sql).toContain("ORDER BY created_at DESC");
      expect(sql).not.toMatch(/WHERE\s+id\s*=/);  // avatarConfigId パスでないことを確認
      expect(mockQuery.mock.calls[0][1]).toEqual(["r2c_default"]);
    });

    it("is_active アバターなし → config: null", async () => {
      mockPool([]);
      const res = await signedGet(makeApp(), "/api/internal/avatar-config?tenantId=empty-tenant");

      expect(res.status).toBe(200);
      expect(res.body.config).toBeNull();
    });
  });

  describe("LemonSliceペルソナスワップ: category_persona_map の伝搬", () => {
    it("SELECT句に category_persona_map が含まれる（avatar-agentがカテゴリ別ペルソナを取得できる）", async () => {
      const mockQuery = mockPool([AVATAR_ROW]);
      await signedGet(makeApp(), "/api/internal/avatar-config?tenantId=r2c_default");

      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain("category_persona_map");
    });

    it("category_persona_map を含む行がそのまま config として返る", async () => {
      mockPool([{ ...AVATAR_ROW, category_persona_map: { fashion: { agent_prompt: "stylish" } } }]);
      const res = await signedGet(makeApp(), "/api/internal/avatar-config?tenantId=r2c_default");

      expect(res.body.config.category_persona_map).toEqual({ fashion: { agent_prompt: "stylish" } });
    });
  });

  describe("クエリ失敗時の可観測性", () => {
    // 回帰ガード: catch が例外を握りつぶしていたため、本番でマイグレーション未適用による
    // カラム欠落(例: category_persona_map)が起きても原因が一切ログに出ず、
    // avatar-agent 側は 500 を「設定なし」と解釈して無関係な第三者のアバターに
    // 無言でフォールバックし続けた。原因特定に3週間かかっている。
    it("SQLエラーの内容をログに残したうえで 500 を返す", async () => {
      const dbError = new Error('column "category_persona_map" does not exist');
      mockGetPool.mockReturnValue({ query: jest.fn().mockRejectedValue(dbError) });

      const res = await signedGet(makeApp(), "/api/internal/avatar-config?tenantId=r2c_default");

      expect(res.status).toBe(500);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("avatar-config"), dbError);
    });

    it("エラー応答に内部情報(SQL文・カラム名)を含めない", async () => {
      mockGetPool.mockReturnValue({
        query: jest.fn().mockRejectedValue(new Error('column "category_persona_map" does not exist')),
      });

      const res = await signedGet(makeApp(), "/api/internal/avatar-config?tenantId=r2c_default");

      expect(JSON.stringify(res.body)).not.toContain("category_persona_map");
    });
  });

  // ── HMAC 認証(P0) ────────────────────────────────────────────────────────
  describe("HMAC 認証", () => {
    it("正しい署名 → 200(DB照会に到達)", async () => {
      mockPool([AVATAR_ROW]);
      const res = await signedGet(makeApp(), "/api/internal/avatar-config?tenantId=tenant-a");
      expect(res.status).toBe(200);
    });

    it("X-Internal-Request はあるが HMAC ヘッダ欠落 → 401(署名無しで他テナント設定を読めない)", async () => {
      const app = makeApp();
      const spy = mockPool([AVATAR_ROW]);
      const res = await request(app)
        .get("/api/internal/avatar-config?tenantId=victim-tenant")
        .set("X-Internal-Request", "1");

      expect(res.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    });

    it("署名が不正(別 secret) → 401", async () => {
      const app = makeApp();
      const spy = mockPool([AVATAR_ROW]);
      const res = await request(app)
        .get("/api/internal/avatar-config?tenantId=victim-tenant")
        .set(hmacHeaders("attacker-secret"));

      expect(res.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    });

    it("タイムスタンプが許容範囲外(古い) → 401", async () => {
      const app = makeApp();
      const spy = mockPool([AVATAR_ROW]);
      const staleTs = (Math.floor(Date.now() / 1000) - 3600).toString();
      const res = await request(app)
        .get("/api/internal/avatar-config?tenantId=tenant-a")
        .set(hmacHeaders(HMAC_SECRET, staleTs));

      expect(res.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    });

    it("secret 未設定 → fail-closed 500", async () => {
      const app = makeApp();
      const spy = mockPool([AVATAR_ROW]);
      delete process.env.INTERNAL_API_HMAC_SECRET;
      const res = await request(app)
        .get("/api/internal/avatar-config?tenantId=tenant-a")
        .set(hmacHeaders());

      expect(res.status).toBe(500);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
