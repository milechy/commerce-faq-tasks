// tests/phase38/chat-history-escalation.test.ts
// GID 1216275508391900: 有人チャットへのシームレスエスカレーション — admin API

jest.mock("../../src/lib/db", () => ({ getPool: jest.fn() }));
jest.mock("../../src/api/admin/chat-history/chatHistoryRepository");

import express from "express";
import request from "supertest";
import { getPool } from "../../src/lib/db";
import { registerChatHistoryRoutes } from "../../src/api/admin/chat-history/routes";
import {
  getActiveEscalations,
  resolveEscalation,
  saveMessage,
} from "../../src/api/admin/chat-history/chatHistoryRepository";

const mockGetPool = getPool as jest.MockedFunction<typeof getPool>;
const mockGetActiveEscalations = getActiveEscalations as jest.MockedFunction<typeof getActiveEscalations>;
const mockResolveEscalation = resolveEscalation as jest.MockedFunction<typeof resolveEscalation>;
const mockSaveMessage = saveMessage as jest.MockedFunction<typeof saveMessage>;

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const SUPER_ADMIN_TOKEN = makeDevJwt({ app_metadata: { role: "super_admin" } });
const CLIENT_ADMIN_TOKEN = makeDevJwt({ app_metadata: { role: "client_admin", tenant_id: "tenant-a" } });

describe("Chat History Escalation API", () => {
  let app: express.Application;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    registerChatHistoryRoutes(app);
  });

  describe("GET /v1/admin/chat-history/escalations", () => {
    it("super_admin → 全テナントの一覧 200", async () => {
      mockGetActiveEscalations.mockResolvedValueOnce([
        { id: "s1", tenant_id: "tenant-a", session_id: "sess-1", escalated_at: "2026-01-01T00:00:00Z", last_message_at: "2026-01-01T00:00:00Z", message_count: 3, first_message_preview: "help" },
      ]);
      const res = await request(app)
        .get("/v1/admin/chat-history/escalations")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.escalations).toHaveLength(1);
      expect(mockGetActiveEscalations).toHaveBeenCalledWith(undefined);
    });

    it("client_admin → 自テナントのみ 200", async () => {
      mockGetActiveEscalations.mockResolvedValueOnce([]);
      const res = await request(app)
        .get("/v1/admin/chat-history/escalations")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(mockGetActiveEscalations).toHaveBeenCalledWith("tenant-a");
    });

    it("認証なし → 401", async () => {
      const res = await request(app).get("/v1/admin/chat-history/escalations");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /v1/admin/chat-history/sessions/:sessionId/reply", () => {
    it("正常系 → 201 + saveMessageがrole=operatorで呼ばれる", async () => {
      const pool = { query: jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "s1", tenant_id: "tenant-a", session_id: "sess-1" }] }) };
      mockGetPool.mockReturnValue(pool as any);
      mockSaveMessage.mockResolvedValueOnce(undefined);

      const res = await request(app)
        .post("/v1/admin/chat-history/sessions/s1/reply")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ content: "担当者が対応します" });

      expect(res.status).toBe(201);
      expect(mockSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a", sessionId: "sess-1", role: "operator", content: "担当者が対応します" }),
      );
    });

    it("空contentは400", async () => {
      const res = await request(app)
        .post("/v1/admin/chat-history/sessions/s1/reply")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ content: "" });
      expect(res.status).toBe(400);
      expect(mockSaveMessage).not.toHaveBeenCalled();
    });

    it("存在しないセッション → 404", async () => {
      const pool = { query: jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] }) };
      mockGetPool.mockReturnValue(pool as any);
      const res = await request(app)
        .post("/v1/admin/chat-history/sessions/nonexistent/reply")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ content: "hi" });
      expect(res.status).toBe(404);
    });

    it("client_adminが他テナントのセッションに返信 → 403", async () => {
      const pool = { query: jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "s1", tenant_id: "tenant-b", session_id: "sess-1" }] }) };
      mockGetPool.mockReturnValue(pool as any);
      const res = await request(app)
        .post("/v1/admin/chat-history/sessions/s1/reply")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
        .send({ content: "hi" });
      expect(res.status).toBe(403);
      expect(mockSaveMessage).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /v1/admin/chat-history/sessions/:sessionId/resolve-escalation", () => {
    it("正常系 → 200", async () => {
      mockResolveEscalation.mockResolvedValueOnce(true);
      const res = await request(app)
        .patch("/v1/admin/chat-history/sessions/s1/resolve-escalation")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(mockResolveEscalation).toHaveBeenCalledWith({ sessionDbId: "s1", tenantId: "tenant-a" });
    });

    it("存在しないセッション → 404", async () => {
      mockResolveEscalation.mockResolvedValueOnce(false);
      const res = await request(app)
        .patch("/v1/admin/chat-history/sessions/nonexistent/resolve-escalation")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
    });

    it("super_adminはtenantId undefinedで呼ばれる", async () => {
      mockResolveEscalation.mockResolvedValueOnce(true);
      const res = await request(app)
        .patch("/v1/admin/chat-history/sessions/s1/resolve-escalation")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(mockResolveEscalation).toHaveBeenCalledWith({ sessionDbId: "s1", tenantId: undefined });
    });
  });
});
