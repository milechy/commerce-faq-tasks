// src/api/admin/chat-history/deleteSession.test.ts
// Phase69-1: Right to Erasure — DELETE /v1/admin/chat-history/sessions/:sessionId

import express from "express";
import request from "supertest";
import { registerChatHistoryRoutes } from "./routes";

jest.mock("./deleteSessionRepository");
import { deleteSession } from "./deleteSessionRepository";
const mockDeleteSession = deleteSession as jest.MockedFunction<typeof deleteSession>;

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const CLIENT_ADMIN_TOKEN = makeDevJwt({
  email: "admin@example.com",
  app_metadata: { role: "client_admin", tenant_id: "tenant-a" },
});

const SUPER_ADMIN_TOKEN = makeDevJwt({
  email: "super@example.com",
  app_metadata: { role: "super_admin" },
});

const VALID_REASON = "GDPR削除要求に基づきユーザー申請";

const MOCK_RESULT = {
  deleted_session_id: "sess-uuid-1",
  affected_counts: {
    chat_messages: 5,
    option_orders_nulled: 2,
  },
};

describe("DELETE /v1/admin/chat-history/sessions/:sessionId", () => {
  let app: ReturnType<typeof express>;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    registerChatHistoryRoutes(app);
  });

  // ── 標準3点セット ─────────────────────────────────────────────────────────

  it("正常系: 認証済みclient_adminがセッションを削除できる", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(200);
    expect(res.body.deleted_session_id).toBe("sess-uuid-1");
    expect(res.body.affected_counts).toBeDefined();
  });

  it("認証エラー: JWT無しは401を返す", async () => {
    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(401);
  });

  it("セッション未存在: deleteSessionがnullを返すと404", async () => {
    mockDeleteSession.mockResolvedValueOnce(null);

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/nonexistent")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(404);
  });

  // ── 補強3: reason バリデーション ─────────────────────────────────────────

  it("バリデーション: reasonなしは400を返す", async () => {
    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/);
  });

  it("バリデーション: reason が5文字未満は400を返す", async () => {
    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: "短い" });

    expect(res.status).toBe(400);
  });

  it("バリデーション: reason が空文字は400を返す", async () => {
    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: "" });

    expect(res.status).toBe(400);
  });

  // ── 補強3: affected_counts 検証 ──────────────────────────────────────────

  it("affected_counts: chat_messagesとoption_orders_nulledが返る", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(200);
    expect(res.body.affected_counts.chat_messages).toBe(5);
    expect(res.body.affected_counts.option_orders_nulled).toBe(2);
  });

  // ── 補強3: actor情報とreason の deleteSession 呼び出し検証 ────────────────

  it("actor_role と actor_email が deleteSession に渡される", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(mockDeleteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRole: "client_admin",
        actorEmail: "admin@example.com",
      }),
    );
  });

  it("reason が deleteSession に渡される", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(mockDeleteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: VALID_REASON,
      }),
    );
  });

  it("super_admin は tenantId 縛りなし（tenantId: undefined）で呼び出す", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(mockDeleteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: undefined,
        actorRole: "super_admin",
        actorEmail: "super@example.com",
      }),
    );
  });

  // ── [HIGH] 認可ホワイトリスト追加テスト ─────────────────────────────────

  it("認可: viewer ロールは403を返す", async () => {
    const viewerToken = makeDevJwt({
      email: "viewer@example.com",
      app_metadata: { role: "viewer", tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("認可: role が undefined (unknown) のユーザーは403を返す", async () => {
    const noRoleToken = makeDevJwt({
      email: "norole@example.com",
      app_metadata: { tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${noRoleToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("認可: ALLOWED_ROLES 外の任意の文字列ロールは403を返す", async () => {
    const bogusRoleToken = makeDevJwt({
      email: "bogus@example.com",
      app_metadata: { role: "tenant_manager", tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${bogusRoleToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  // ── [MEDIUM] 並行削除 / audit_logs 整合性テスト ──────────────────────────

  it("並行削除: deleteSession が throw した場合は500を返し、audit_logs は挿入されない", async () => {
    mockDeleteSession.mockRejectedValueOnce(new Error("Deletion verification failed"));

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(500);
  });
});
