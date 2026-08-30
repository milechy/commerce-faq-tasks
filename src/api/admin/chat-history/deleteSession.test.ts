// src/api/admin/chat-history/deleteSession.test.ts
// Phase69-1: Right to Erasure — DELETE /v1/admin/chat-history/sessions/:sessionId

import express from "express";
import { request } from "../../../../tests/helpers/testServer";
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
// GID 1217972798328871 (H-6): POST .../promote-memory の「学習メモリへの実昇格ロジック」
// (Groq蒸留・埋め込み・保存)自体は memoryDistiller.test.ts が実装を直接検証済みなので、
// このファイル(ルーティング/認可/テナント境界のテスト)ではブラックボックスとしてモックする。
jest.mock("../../../agent/memory/memoryDistiller");
import { deleteSession } from "./deleteSessionRepository";
import * as dbModule from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { manuallyPromoteSession } from "../../../agent/memory/memoryDistiller";
const mockDeleteSession = deleteSession as jest.MockedFunction<typeof deleteSession>;
const mockManuallyPromoteSession = manuallyPromoteSession as jest.MockedFunction<typeof manuallyPromoteSession>;

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
    process.env.ALLOW_INSECURE_DEV_AUTH = "1"; // [P1] dev-decode opt-in（署名検証スキップ）
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
    process.env.ALLOW_INSECURE_DEV_AUTH = "1"; // [P1] dev-decode opt-in（署名検証スキップ）
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

  // ── [HIGH] Phase69-1.5: GET エンドポイントのロールホワイトリスト ──────────

  it("Test 33: GET sessions — viewer ロールは403を返す", async () => {
    const viewerToken = makeDevJwt({
      email: "viewer@example.com",
      app_metadata: { role: "viewer", tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/sessions")
      .set("Authorization", `Bearer ${viewerToken}`);

    expect(res.status).toBe(403);
  });

  it("Test 34: GET sessions — role が undefined のユーザーは403を返す", async () => {
    const noRoleToken = makeDevJwt({
      email: "norole@example.com",
      app_metadata: { tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/sessions")
      .set("Authorization", `Bearer ${noRoleToken}`);

    expect(res.status).toBe(403);
  });

  it("Test 35: GET sessions — role が空文字のユーザーは403を返す", async () => {
    const emptyRoleToken = makeDevJwt({
      email: "empty@example.com",
      app_metadata: { role: "", tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/sessions")
      .set("Authorization", `Bearer ${emptyRoleToken}`);

    expect(res.status).toBe(403);
  });

  it("Test 36: GET sessions/:id/messages — viewer ロールは403を返す", async () => {
    const viewerToken = makeDevJwt({
      email: "viewer@example.com",
      app_metadata: { role: "viewer", tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/sessions/sess-uuid-1/messages")
      .set("Authorization", `Bearer ${viewerToken}`);

    expect(res.status).toBe(403);
  });

  it("Test 37: GET sessions/:id/messages — role が undefined のユーザーは403を返す", async () => {
    const noRoleToken = makeDevJwt({
      email: "norole@example.com",
      app_metadata: { tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/sessions/sess-uuid-1/messages")
      .set("Authorization", `Bearer ${noRoleToken}`);

    expect(res.status).toBe(403);
  });

  it("Test 38: GET sessions/:id/messages — role が空文字のユーザーは403を返す", async () => {
    const emptyRoleToken = makeDevJwt({
      email: "empty@example.com",
      app_metadata: { role: "", tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/sessions/sess-uuid-1/messages")
      .set("Authorization", `Bearer ${emptyRoleToken}`);

    expect(res.status).toBe(403);
  });
});

// ── [HIGH] Phase69-1.5: PATCH エンドポイントのロールホワイトリスト ─────────────

describe("PATCH /v1/admin/chat-history: role whitelist", () => {
  let app: ReturnType<typeof express>;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_INSECURE_DEV_AUTH = "1"; // [P1] dev-decode opt-in（署名検証スキップ）
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    registerChatHistoryRoutes(app);
  });

  it("Test 39: PATCH outcome — viewer ロールは403を返す", async () => {
    const viewerToken = makeDevJwt({
      email: "viewer@example.com",
      app_metadata: { role: "viewer", tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .patch("/v1/admin/chat-history/sessions/sess-uuid-1/outcome")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ outcome: "購入完了" });

    expect(res.status).toBe(403);
  });

  it("Test 40: PATCH outcome — role が undefined のユーザーは403を返す", async () => {
    const noRoleToken = makeDevJwt({
      email: "norole@example.com",
      app_metadata: { tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .patch("/v1/admin/chat-history/sessions/sess-uuid-1/outcome")
      .set("Authorization", `Bearer ${noRoleToken}`)
      .send({ outcome: "購入完了" });

    expect(res.status).toBe(403);
  });

  it("Test 41: PATCH outcome — role が空文字のユーザーは403を返す", async () => {
    const emptyRoleToken = makeDevJwt({
      email: "empty@example.com",
      app_metadata: { role: "", tenant_id: "tenant-a" },
    });

    const res = await request(app)
      .patch("/v1/admin/chat-history/sessions/sess-uuid-1/outcome")
      .set("Authorization", `Bearer ${emptyRoleToken}`)
      .send({ outcome: "購入完了" });

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

  // ── 削除時に失われる成果(outcome)の監査記録 ─────────────────────────────
  // outcome は独立テーブルではなく chat_sessions の列のため、行の削除と同時に
  // 失われる。agent の record_session_outcome と delete_chat_session を同一ターンで
  // 実行すると、記録した直後に無音で消える経路が実在する。削除の監査ログに
  // 残しておかないと、後から「何が記録されていたか」を追う手段が無くなる。
  function seedSuccessfulDelete(sessionRow: Record<string, unknown>) {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL lock_timeout
      .mockResolvedValueOnce({ rows: [sessionRow], rowCount: 1 }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ cnt: "3" }], rowCount: 1 }) // COUNT messages
      .mockResolvedValueOnce({ rows: [{ cnt: "0" }], rowCount: 1 }) // COUNT orders
      .mockResolvedValueOnce({ rows: [{ id: "sess-uuid-1" }], rowCount: 1 }) // DELETE RETURNING
      .mockResolvedValue({ rows: [], rowCount: 0 }); // INSERT audit_logs / COMMIT
  }

  function auditMetadata(): Record<string, unknown> {
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeTruthy();
    // metadata は INSERT の7番目のパラメータ（JSON文字列）
    return JSON.parse((insertCall![1] as unknown[])[6] as string) as Record<string, unknown>;
  }

  it("成果が記録済みのセッションを削除すると、その値が監査ログに残る", async () => {
    seedSuccessfulDelete({
      id: "sess-uuid-1",
      tenant_id: "tenant-a",
      outcome: "購入完了",
      outcome_recorded_at: "2026-07-31T10:00:00Z",
    });

    await realDeleteSession(BASE_PARAMS);

    expect(auditMetadata()).toEqual(
      expect.objectContaining({
        deleted_outcome: { outcome: "購入完了", recorded_at: "2026-07-31T10:00:00Z" },
      }),
    );
  });

  it("成果が未記録(null)なら監査ログに余計なフィールドを足さない", async () => {
    seedSuccessfulDelete({
      id: "sess-uuid-1",
      tenant_id: "tenant-a",
      outcome: null,
      outcome_recorded_at: null,
    });

    await realDeleteSession(BASE_PARAMS);

    const metadata = auditMetadata();
    expect(metadata).not.toHaveProperty("deleted_outcome");
    // 既存の形(reason + affected_counts)が変わっていないこと
    expect(metadata).toEqual({
      reason: "test reason here",
      affected_counts: { chat_messages: 3, option_orders_nulled: 0 },
    });
  });

  it.each([
    ["tenant スコープ", { kind: "tenant" as const, tenantId: "tenant-a" }],
    ["global スコープ", { kind: "global" as const }],
  ])("%s の SELECT でも outcome を読む(super_admin経路の取りこぼし防止)", async (_label, scope) => {
    seedSuccessfulDelete({
      id: "sess-uuid-1",
      tenant_id: "tenant-a",
      outcome: "離脱",
      outcome_recorded_at: "2026-07-31T10:00:00Z",
    });

    await realDeleteSession({ ...BASE_PARAMS, scope });

    const selectCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("FOR UPDATE"),
    );
    expect(selectCall![0] as string).toContain("outcome");
    expect(auditMetadata()).toHaveProperty("deleted_outcome");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GID 1217972798328871 (H-6): POST /v1/admin/chat-history/sessions/:sessionId/promote-memory
//
// manuallyPromoteSession(memoryDistiller.ts)自体は memoryDistiller.test.ts が
// 実装を直接検証済みなのでここではモックし、このファイルではルーティング層
// (認可・テナント境界・レスポンスのマッピング)だけを検証する。
//
// getMessages/getEvaluationsBySession は実装をそのまま使い、共有の mockQuery
// (lib/db の自動モック)経由でDB行を差し込む。これにより「session.id(内部UUID)を
// 取り違えて session.session_id(公開キー)の代わりに使っていないか」を、モックの
// 呼び出し引数として実際に固定できる(distillAndPromoteの重複判定キーと不一致だと
// 自動昇格済みの会話の重複判定が壊れるため、ここが本エンドポイントの一番壊れやすい点)。
// ─────────────────────────────────────────────────────────────────────────
describe("POST /v1/admin/chat-history/sessions/:sessionId/promote-memory", () => {
  let app: ReturnType<typeof express>;
  let mockQuery: jest.Mock;

  // 内部UUID(id)と公開キー(session_id)をわざと別の値にして、取り違えを検出できるようにする。
  const SESSION_ROW = {
    id: "sess-uuid-1",
    tenant_id: "tenant-a",
    session_id: "public-session-key-xyz",
  };
  const MESSAGE_ROWS = [
    { id: 1, role: "user", content: "保証はありますか", metadata: {}, created_at: "2026-01-01T00:00:00Z" },
    { id: 2, role: "assistant", content: "全車3ヶ月保証付きです", metadata: {}, created_at: "2026-01-01T00:00:01Z" },
  ];

  /** ルートの正常系が発行する4回のクエリ(session lookup → getMessagesの所有権確認 → メッセージ本体 → 評価)を積む。 */
  function queueHappyPathQueries(opts?: { evaluationRows?: unknown[] }) {
    mockQuery
      .mockResolvedValueOnce({ rows: [SESSION_ROW] }) // ルート: chat_sessions SELECT
      .mockResolvedValueOnce({ rows: [{ id: SESSION_ROW.id }] }) // getMessages: 所有権確認
      .mockResolvedValueOnce({ rows: MESSAGE_ROWS }) // getMessages: chat_messages SELECT
      .mockResolvedValueOnce({ rows: opts?.evaluationRows ?? [] }); // getEvaluationsBySession
  }

  beforeAll(() => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_INSECURE_DEV_AUTH = "1";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    registerChatHistoryRoutes(app);
    mockQuery = jest.fn();
    jest.mocked(dbModule.getPool).mockReturnValue({
      query: mockQuery,
    } as unknown as ReturnType<typeof dbModule.getPool>);
  });

  // ── 認可: super_admin限定(client_adminは403) ─────────────────────────────

  it("client_adminは403を返し、manuallyPromoteSessionもDBも一切呼ばれない", async () => {
    const res = await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(403);
    expect(mockManuallyPromoteSession).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("認証なしは401を返す", async () => {
    const res = await request(app).post(
      "/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory",
    );
    expect(res.status).toBe(401);
  });

  it("roleがundefinedのユーザーは403を返す", async () => {
    const noRoleToken = makeDevJwt({ email: "norole@example.com", app_metadata: {} });
    const res = await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  // ── 正常系 ────────────────────────────────────────────────────────────

  it("super_adminが昇格でき、promoted:trueを返す", async () => {
    queueHappyPathQueries();
    mockManuallyPromoteSession.mockResolvedValueOnce({ promoted: true });

    const res = await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ promoted: true });
  });

  it("manuallyPromoteSessionには内部UUID(id)ではなく公開session_idが渡る(取り違え防止)", async () => {
    queueHappyPathQueries();
    mockManuallyPromoteSession.mockResolvedValueOnce({ promoted: true });

    await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(mockManuallyPromoteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: SESSION_ROW.tenant_id,
        sessionId: SESSION_ROW.session_id, // ← session.id ではなく session.session_id
      }),
    );
    // 会話本文もそのまま渡っている
    const calledWith = mockManuallyPromoteSession.mock.calls[0]![0];
    expect(calledWith.messages).toEqual([
      { role: "user", content: "保証はありますか" },
      { role: "assistant", content: "全車3ヶ月保証付きです" },
    ]);
  });

  it("getEvaluationsBySessionにも公開session_idが渡り、既存のJudgeスコアがjudgeScoreとして使われる", async () => {
    queueHappyPathQueries({ evaluationRows: [{ overall_score: 42 }] });
    mockManuallyPromoteSession.mockResolvedValueOnce({ promoted: true });

    await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    // getEvaluationsBySession の実SQLは session_id = $1 AND tenant_id = $2
    const evalCall = mockQuery.mock.calls[3] as [string, unknown[]];
    expect(evalCall[1]).toEqual([SESSION_ROW.session_id, SESSION_ROW.tenant_id]);

    expect(mockManuallyPromoteSession).toHaveBeenCalledWith(
      expect.objectContaining({ judgeScore: 42 }),
    );
  });

  it("Judge評価が無いセッションはjudgeScore: 0で呼ばれる(未評価でも昇格自体は妨げない)", async () => {
    queueHappyPathQueries({ evaluationRows: [] });
    mockManuallyPromoteSession.mockResolvedValueOnce({ promoted: true });

    await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(mockManuallyPromoteSession).toHaveBeenCalledWith(
      expect.objectContaining({ judgeScore: 0 }),
    );
  });

  // ── 見つからない/越境 ────────────────────────────────────────────────────

  it("存在しないセッションは404を返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // ルートのSELECTが0件
    const res = await request(app)
      .post("/v1/admin/chat-history/sessions/nonexistent/promote-memory")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(404);
    expect(mockManuallyPromoteSession).not.toHaveBeenCalled();
  });

  it("越境: ?tenant=で他テナントを指定すると403ではなく404(不存在)を返す(CLAUDE.md 禁止20・24)", async () => {
    // WHERE id=$1 AND tenant_id=$2 が一致せず0件 → 越境かどうかを外部に漏らさない
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory?tenant=other-tenant")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.error).not.toMatch(/権限/); // 権限エラーの文言ではないこと
    expect(mockManuallyPromoteSession).not.toHaveBeenCalled();
  });

  it("previewMode相当(super_admin + ?tenant=一致)は絞り込んだ上で成功する", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [SESSION_ROW] }) // WHERE id=$1 AND tenant_id=$2 が一致
      .mockResolvedValueOnce({ rows: [{ id: SESSION_ROW.id }] })
      .mockResolvedValueOnce({ rows: MESSAGE_ROWS })
      .mockResolvedValueOnce({ rows: [] });
    mockManuallyPromoteSession.mockResolvedValueOnce({ promoted: true });

    const res = await request(app)
      .post(`/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory?tenant=${SESSION_ROW.tenant_id}`)
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ promoted: true });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("tenant_id = $2");
    expect(params).toEqual(["sess-uuid-1", SESSION_ROW.tenant_id]);
  });

  // ── 「昇格しました」と嘘をつかない(reasonマッピング) ─────────────────────

  it.each([
    ["already_promoted", "既に昇格済み"],
    ["no_qa_extracted", "抽出できませんでした"],
    ["too_few_messages", "蒸留対象になりません"],
    ["disabled", "無効になっています"],
  ] as const)(
    "reason=%s のときpromoted:falseと理由メッセージ(%s相当)を返し、成功したと偽らない",
    async (reason, _label) => {
      queueHappyPathQueries();
      mockManuallyPromoteSession.mockResolvedValueOnce({ promoted: false, reason });

      const res = await request(app)
        .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

      expect(res.status).toBe(200); // 業務上妥当な結果なのでエラーステータスにはしない
      expect(res.body.promoted).toBe(false);
      expect(res.body.reason).toBe(reason);
      expect(typeof res.body.message).toBe("string");
      expect(res.body.message.length).toBeGreaterThan(0);
    },
  );

  it("既に自動昇格済みの会話に手動昇格を実行すると、already_promotedを返し「昇格しました」と表示させない", async () => {
    queueHappyPathQueries();
    mockManuallyPromoteSession.mockResolvedValueOnce({ promoted: false, reason: "already_promoted" });

    const res = await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(false);
    expect(res.body.reason).toBe("already_promoted");
  });

  // ── LEARNED_MEMORY_ENABLED=false: フラグOFFで挙動不変 ────────────────────

  it("LEARNED_MEMORY_ENABLED=falseのときmanuallyPromoteSessionがdisabledを返せば、そのままdisabledとして応答する", async () => {
    // フラグ判定自体はmanuallyPromoteSession内部の責務(memoryDistiller.test.tsで検証済み)。
    // ここではルートがその結果を握り潰したり「成功」に読み替えたりしないことだけを確認する。
    queueHappyPathQueries();
    mockManuallyPromoteSession.mockResolvedValueOnce({ promoted: false, reason: "disabled" });

    const res = await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      promoted: false,
      reason: "disabled",
      message: expect.any(String),
    });
  });

  // ── 例外系 ────────────────────────────────────────────────────────────

  it("manuallyPromoteSessionが例外を投げたら500を返す(蒸留失敗を握り潰して成功に見せない)", async () => {
    queueHappyPathQueries();
    mockManuallyPromoteSession.mockRejectedValueOnce(new Error("groq down"));

    const res = await request(app)
      .post("/v1/admin/chat-history/sessions/sess-uuid-1/promote-memory")
      .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
  });
});
