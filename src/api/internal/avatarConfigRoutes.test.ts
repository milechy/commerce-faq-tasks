// src/api/internal/avatarConfigRoutes.test.ts
// GET /api/internal/avatar-config の avatarConfigId 伝搬修正(Path B fix)検証

import express from "express";
import request from "supertest";
import { registerInternalAvatarConfigRoutes } from "./avatarConfigRoutes";

jest.mock("../../lib/db", () => ({
  getPool: jest.fn(),
}));

import { getPool } from "../../lib/db";
const mockGetPool = getPool as jest.Mock;

function makeApp() {
  const app = express();
  registerInternalAvatarConfigRoutes(app);
  return app;
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
  });

  describe("fail-closed: X-Internal-Request ヘッダなし → 403", () => {
    it("ヘッダ欠落で 403", async () => {
      const res = await request(makeApp())
        .get("/api/internal/avatar-config?tenantId=tenant-a");
      expect(res.status).toBe(403);
    });
  });

  describe("tenantId 未指定 → 400", () => {
    it("tenantId なしで 400", async () => {
      const res = await request(makeApp())
        .get("/api/internal/avatar-config")
        .set("X-Internal-Request", "1");
      expect(res.status).toBe(400);
    });
  });

  const UUID_SAM     = "87ca75df-8fd5-4e41-b3e4-1cbdc2d97462";
  const UUID_DEFAULT = "d0d3722c-e033-4d91-8eb2-66a06978548a";
  const UUID_OTHER   = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  describe("avatarConfigId 指定時 (Path B fix)", () => {
    it("自テナントのアバターを ID 指定で取得できる", async () => {
      const mockQuery = mockPool([AVATAR_ROW]);
      const res = await request(makeApp())
        .get(`/api/internal/avatar-config?tenantId=tenant-a&avatarConfigId=${UUID_SAM}`)
        .set("X-Internal-Request", "1");

      expect(res.status).toBe(200);
      expect(res.body.config.lemonslice_agent_id).toBe("agent_289feaadc2983989");

      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain("id = $1");
      expect(sql).toContain("tenant_id = $2");
      expect(sql).toContain("tenant_id = 'r2c_default'");
      expect(mockQuery.mock.calls[0][1]).toEqual([UUID_SAM, "tenant-a"]);
    });

    it("r2c_default のアバターを別テナントから ID 指定で取得できる (cross-tenant)", async () => {
      const mockQuery = mockPool([AVATAR_ROW]);
      const res = await request(makeApp())
        .get(`/api/internal/avatar-config?tenantId=other-tenant&avatarConfigId=${UUID_DEFAULT}`)
        .set("X-Internal-Request", "1");

      expect(res.status).toBe(200);
      expect(res.body.config).not.toBeNull();

      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain("tenant_id = 'r2c_default'");
    });

    it("他テナント非デフォルトアバターは取得できない (0件 → null)", async () => {
      mockPool([]);
      const res = await request(makeApp())
        .get(`/api/internal/avatar-config?tenantId=tenant-a&avatarConfigId=${UUID_OTHER}`)
        .set("X-Internal-Request", "1");

      expect(res.status).toBe(200);
      expect(res.body.config).toBeNull();
    });
  });

  describe("avatarConfigId 未指定時 (fallback: ORDER BY 決定的)", () => {
    it("is_active アバターを ORDER BY created_at DESC で取得する", async () => {
      const mockQuery = mockPool([ARJUN_ROW]);
      const res = await request(makeApp())
        .get("/api/internal/avatar-config?tenantId=r2c_default")
        .set("X-Internal-Request", "1");

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
      const res = await request(makeApp())
        .get("/api/internal/avatar-config?tenantId=empty-tenant")
        .set("X-Internal-Request", "1");

      expect(res.status).toBe(200);
      expect(res.body.config).toBeNull();
    });
  });
});
