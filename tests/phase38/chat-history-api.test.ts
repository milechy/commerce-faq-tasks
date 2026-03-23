// tests/phase38/chat-history-api.test.ts
// Phase38: 会話履歴API — モックExpressアプリを使ったユニットテスト

import express from "express";
import request from "supertest";
import { registerChatHistoryRoutes } from "../../src/api/admin/chat-history/routes";

jest.mock("../../src/api/admin/chat-history/chatHistoryRepository");

import {
  getSessions,
  getMessages,
} from "../../src/api/admin/chat-history/chatHistoryRepository";

const mockGetSessions = getSessions as jest.MockedFunction<typeof getSessions>;
const mockGetMessages = getMessages as jest.MockedFunction<typeof getMessages>;

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const SUPER_ADMIN_TOKEN = makeDevJwt({
  app_metadata: { role: "super_admin", tenant_id: "demo-tenant" },
});

const SESSION_FIXTURE = {
  id: "sess-uuid-1",
  tenant_id: "demo-tenant",
  session_id: "chat-session-abc",
  started_at: new Date().toISOString(),
  last_message_at: new Date().toISOString(),
  message_count: 3,
  first_message_preview: "こんにちは",
};

const MESSAGE_FIXTURE = {
  id: "msg-uuid-1",
  role: "user",
  content: "テストメッセージ",
  metadata: {},
  created_at: new Date().toISOString(),
};

describe("Chat History API", () => {
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

  // -------------------------------------------------------------------------
  // GET /v1/admin/chat-history/sessions
  // -------------------------------------------------------------------------
  describe("GET /v1/admin/chat-history/sessions", () => {
    it("returns 200 and sessions array", async () => {
      mockGetSessions.mockResolvedValueOnce({
        sessions: [SESSION_FIXTURE] as any,
        total: 1,
      });

      const res = await request(app)
        .get("/v1/admin/chat-history/sessions")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
    });

    it("each session has id, tenant_id, and started_at", async () => {
      mockGetSessions.mockResolvedValueOnce({
        sessions: [SESSION_FIXTURE] as any,
        total: 1,
      });

      const res = await request(app)
        .get("/v1/admin/chat-history/sessions")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      const session = res.body.sessions[0];
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("tenant_id");
      expect(session).toHaveProperty("started_at");
    });

    it("returns 401 without auth token", async () => {
      const res = await request(app).get("/v1/admin/chat-history/sessions");
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/chat-history/sessions/:sessionId/messages
  // -------------------------------------------------------------------------
  describe("GET /v1/admin/chat-history/sessions/:sessionId/messages", () => {
    it("returns 200 and messages array", async () => {
      mockGetMessages.mockResolvedValueOnce([MESSAGE_FIXTURE] as any);

      const res = await request(app)
        .get("/v1/admin/chat-history/sessions/sess-uuid-1/messages")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.messages)).toBe(true);
    });

    it("each message has id, role, content, created_at", async () => {
      mockGetMessages.mockResolvedValueOnce([MESSAGE_FIXTURE] as any);

      const res = await request(app)
        .get("/v1/admin/chat-history/sessions/sess-uuid-1/messages")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      const msg = res.body.messages[0];
      expect(msg).toHaveProperty("id");
      expect(msg).toHaveProperty("role");
      expect(msg).toHaveProperty("content");
      expect(msg).toHaveProperty("created_at");
    });

    it("returns 404 when getMessages returns empty array", async () => {
      mockGetMessages.mockResolvedValueOnce([]);

      const res = await request(app)
        .get("/v1/admin/chat-history/sessions/nonexistent/messages")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(404);
    });

    it("returns 401 without auth token", async () => {
      const res = await request(app).get(
        "/v1/admin/chat-history/sessions/sess-uuid-1/messages"
      );
      expect(res.status).toBe(401);
    });
  });
});
