// src/api/admin/chat-history/deleteSession.test.ts
// Phase69-1: Right to Erasure — DELETE /v1/admin/chat-history/sessions/:sessionId

import express from "express";
import request from "supertest";
import { registerChatHistoryRoutes } from "./routes";

jest.mock("./deleteSessionRepository");
jest.mock("../../../lib/db");
jest.mock("../../../lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
  },
}));
import { deleteSession } from "./deleteSessionRepository";
import * as dbModule from "../../../lib/db";
import { logger } from "../../../lib/logger";
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

  it("super_admin は scope: global で呼び出す（テナント縛りなし）", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(mockDeleteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "global" },
        actorRole: "super_admin",
        actorEmail: "super@example.com",
      }),
    );
  });

  it("client_admin は scope: tenant で呼び出す（自テナント限定）", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(mockDeleteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "tenant", tenantId: "tenant-a" },
        actorRole: "client_admin",
      }),
    );
  });

  // ── [HIGH] Round2: client_admin の tenantId 必須チェック ─────────────────

  it("認可: client_admin で tenantId が空（app_metadata なし）は403を返す", async () => {
    const noTenantToken = makeDevJwt({
      email: "admin@example.com",
      app_metadata: { role: "client_admin" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${noTenantToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("認可: client_admin で tenant_id が空文字は403を返す", async () => {
    const emptyTenantToken = makeDevJwt({
      email: "admin@example.com",
      app_metadata: { role: "client_admin", tenant_id: "" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${emptyTenantToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("認可: client_admin で tenant_id がスペースのみは403を返す", async () => {
    const spaceTenantToken = makeDevJwt({
      email: "admin@example.com",
      app_metadata: { role: "client_admin", tenant_id: "   " },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${spaceTenantToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
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

  // ── [HIGH] lock_timeout (55P03) → 409 ────────────────────────────────────

  it("Test 17: lock_timeout エラー (55P03) 発生時は409を返す", async () => {
    const lockErr = Object.assign(new Error("lock timeout"), { code: "55P03" });
    mockDeleteSession.mockRejectedValueOnce(lockErr);

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/再度お試し/);
  });

  // ── [CRITICAL] Round 5: user_metadata.role フォールバック削除 ─────────────
  // app_metadata.role のみを信頼し、user_metadata.role は無視することを確認

  it("Test 21: app_metadata.role='super_admin', user_metadata なし → 200 (正常系)", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(200);
    expect(res.body.deleted_session_id).toBe("sess-uuid-1");
  });

  it("Test 22 [攻撃シナリオ]: app_metadata.role なし, user_metadata.role='super_admin' → 403", async () => {
    const attackToken = makeDevJwt({
      email: "attacker@example.com",
      user_metadata: { role: "super_admin" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${attackToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("Test 23 [攻撃シナリオ]: app_metadata.role なし, user_metadata.role='client_admin' → 403", async () => {
    const attackToken = makeDevJwt({
      email: "attacker@example.com",
      user_metadata: { role: "client_admin" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${attackToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("Test 24: app_metadata.role='viewer', user_metadata.role='super_admin' → 403 (ALLOWED_ROLES外)", async () => {
    const mixedToken = makeDevJwt({
      email: "viewer@example.com",
      app_metadata: { role: "viewer", tenant_id: "tenant-a" },
      user_metadata: { role: "super_admin" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${mixedToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("Test 25: app_metadata.role なし, user_metadata.role なし → 403", async () => {
    const noRoleToken = makeDevJwt({
      email: "nobody@example.com",
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${noRoleToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  // ── [HIGH] Round 6: jwtTenantId の su.tenant_id フォールバック削除 ──────────
  // app_metadata.tenant_id のみを信頼し、top-level tenant_id は無視することを確認

  it("Test 26: app_metadata.tenant_id='t1', su.tenant_id='t2' → t1 でスコープ (cross-tenant 防止)", async () => {
    mockDeleteSession.mockResolvedValueOnce(MOCK_RESULT);

    const crossTenantToken = makeDevJwt({
      email: "admin@example.com",
      tenant_id: "t2",
      app_metadata: { role: "client_admin", tenant_id: "t1" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${crossTenantToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(200);
    expect(mockDeleteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "tenant", tenantId: "t1" },
      }),
    );
  });

  it("Test 27 [攻撃シナリオ]: app_metadata.tenant_id なし, su.tenant_id='t1' → 403", async () => {
    const noAppTenantToken = makeDevJwt({
      email: "attacker@example.com",
      tenant_id: "t1",
      app_metadata: { role: "client_admin" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${noAppTenantToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("Test 28 [攻撃シナリオ]: app_metadata.tenant_id='', su.tenant_id='t1' → 403 (空文字攻撃)", async () => {
    const emptyAppTenantToken = makeDevJwt({
      email: "attacker@example.com",
      tenant_id: "t1",
      app_metadata: { role: "client_admin", tenant_id: "" },
    });

    const res = await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${emptyAppTenantToken}`)
      .send({ reason: VALID_REASON });

    expect(res.status).toBe(403);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  // ── [MEDIUM] Round 6: 55P03 structured warning ログ ─────────────────────────

  it("Test 31: 55P03 エラー発生時、logger.warn が呼ばれる", async () => {
    const lockErr = Object.assign(new Error("lock timeout"), { code: "55P03" });
    mockDeleteSession.mockRejectedValueOnce(lockErr);

    await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(logger.warn).toHaveBeenCalled();
  });

  it("Test 32: 55P03 logger.warn payload に必要フィールドが含まれる", async () => {
    const lockErr = Object.assign(new Error("lock timeout"), { code: "55P03" });
    mockDeleteSession.mockRejectedValueOnce(lockErr);

    await request(app)
      .delete("/v1/admin/chat-history/sessions/sess-uuid-1")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`)
      .send({ reason: VALID_REASON });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat_history_delete_lock_timeout",
        errorCode: "55P03",
        sessionId: "sess-uuid-1",
      }),
      expect.any(String),
    );
  });
});

// ── [HIGH] Round 6: GET 系エンドポイントの jwtTenantId フォールバック削除 ──────

describe("GET /v1/admin/chat-history: tenant_id fallback 削除", () => {
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

  it("Test 29: GET sessions 一覧で app_metadata.tenant_id なし, su.tenant_id あり → 403", async () => {
    const noAppTenantToken = makeDevJwt({
      email: "attacker@example.com",
      tenant_id: "t1",
      app_metadata: { role: "client_admin" },
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/sessions")
      .set("Authorization", `Bearer ${noAppTenantToken}`);

    expect(res.status).toBe(403);
  });

  it("Test 30: GET sessions/:id/messages で app_metadata.tenant_id なし, su.tenant_id あり → 403", async () => {
    const noAppTenantToken = makeDevJwt({
      email: "attacker@example.com",
      tenant_id: "t1",
      app_metadata: { role: "client_admin" },
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/sessions/sess-uuid-1/messages")
      .set("Authorization", `Bearer ${noAppTenantToken}`);

    expect(res.status).toBe(403);
  });
});

// ── リポジトリ内部クエリ整合性テスト（Tests 18-20） ──────────────────────────
// deleteSession の実装を直接テスト: lib/db をモックしてクエリシーケンスを検証

describe("deleteSessionRepository: lock_timeout / ROLLBACK 整合性", () => {
  let mockQuery: jest.Mock;
  let mockRelease: jest.Mock;
  let realDeleteSession: (p: Parameters<typeof import("./deleteSessionRepository").deleteSession>[0]) => Promise<unknown>;

  const BASE_PARAMS = {
    sessionDbId: "sess-uuid-1",
    scope: { kind: "global" as const },
    actorRole: "super_admin",
    actorEmail: "super@example.com",
    reason: "test reason here",
  };

  beforeEach(() => {
    mockQuery = jest.fn();
    mockRelease = jest.fn();

    jest.mocked(dbModule.getPool).mockReturnValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    } as unknown as ReturnType<typeof dbModule.getPool>);

    realDeleteSession = (jest.requireActual<typeof import("./deleteSessionRepository")>(
      "./deleteSessionRepository",
    ) as { deleteSession: typeof realDeleteSession }).deleteSession;
  });

  it("Test 18: BEGIN 直後に SET LOCAL lock_timeout = '3s' が実行される", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // session not found → return null

    await realDeleteSession(BASE_PARAMS);

    const calls = mockQuery.mock.calls.map((c) => c[0] as string);
    const beginIdx = calls.findIndex((q) => q === "BEGIN");
    const lockIdx = calls.findIndex((q) => q === "SET LOCAL lock_timeout = '3s'");

    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBe(beginIdx + 1);
  });

  it("Test 19: rowCount !== 1 検証失敗時、手動 ROLLBACK は呼ばれず catch の ROLLBACK のみ（合計1回）", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL lock_timeout
      .mockResolvedValueOnce({                           // SELECT FOR UPDATE → found
        rows: [{ id: "sess-uuid-1", tenant_id: "tenant-a" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ cnt: "2" }], rowCount: 1 }) // COUNT messages
      .mockResolvedValueOnce({ rows: [{ cnt: "0" }], rowCount: 1 }) // COUNT orders (0)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DELETE RETURNING → rowCount=0
      .mockResolvedValue({ rows: [], rowCount: 0 }); // ROLLBACK

    await expect(realDeleteSession(BASE_PARAMS)).rejects.toThrow("Deletion verification failed");

    const rollbackCalls = mockQuery.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).toUpperCase() === "ROLLBACK",
    );
    expect(rollbackCalls).toHaveLength(1); // catch のみ、手動 ROLLBACK なし
  });

  it("Test 20: DB エラー発生時に catch block が ROLLBACK を実行し connection を release する", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL lock_timeout
      .mockRejectedValueOnce(new Error("DB connection error")); // SELECT fails

    await expect(realDeleteSession(BASE_PARAMS)).rejects.toThrow("DB connection error");

    const rollbackCalls = mockQuery.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).toUpperCase() === "ROLLBACK",
    );
    expect(rollbackCalls).toHaveLength(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
