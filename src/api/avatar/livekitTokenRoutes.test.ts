// src/api/avatar/livekitTokenRoutes.test.ts
// livekitTokenRoutes POST /api/avatar/room-token のアバター設定取得クエリ検証
//
// 修正内容(Phase66):
//   Q2: OR is_default = true → OR tenant_id = 'r2c_default' (クロステナント誤表示修正)
//   Q3: ORDER BY created_at DESC 追加 (非決定的LIMIT防止)

import express from "express";
import request from "supertest";
import { registerLiveKitTokenRoutes } from "./livekitTokenRoutes";

// ── モック ────────────────────────────────────────────────────────────────────

jest.mock("../../lib/db", () => ({
  pool: { query: jest.fn() },
}));
jest.mock("livekit-server-sdk", () => ({
  RoomServiceClient: jest.fn().mockImplementation(() => ({
    createRoom: jest.fn().mockResolvedValue({}),
  })),
  AgentDispatchClient: jest.fn().mockImplementation(() => ({
    createDispatch: jest.fn().mockResolvedValue({ id: "dispatch-1", room: "room-1" }),
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
  });

  afterEach(() => {
    process.env = savedEnv;
  });

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
        .send({ avatarConfigId: "config-123" });

      expect(res.body.enabled).toBe(true);
      expect(res.body.imageUrl).toBe("https://example.com/img.png");
      expect(res.body.avatarName).toBe("Haruka");

      // Q2クエリが r2c_default 条件を使っていることを検証
      const q2Call = mockQuery.mock.calls[1];
      const sql: string = q2Call[0];
      expect(sql).toContain("tenant_id = 'r2c_default'");
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
        .send({ avatarConfigId: "r2c-default-config-id" });

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
        .send({ avatarConfigId: "config-from-other-tenant" });

      expect(res.body.enabled).toBe(true);
      expect(res.body.imageUrl).toBeNull();
      expect(res.body.avatarName).toBeNull();
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
});
