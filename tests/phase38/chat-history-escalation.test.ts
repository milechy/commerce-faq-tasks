// tests/phase38/chat-history-escalation.test.ts
// GID 1216275508391900: 有人チャットへのシームレスエスカレーション — admin API

jest.mock("../../src/lib/db", () => ({ getPool: jest.fn() }));
jest.mock("../../src/api/admin/chat-history/chatHistoryRepository");

import express from "express";
import { request } from "../helpers/testServer";
import { getPool } from "../../src/lib/db";
import { registerChatHistoryRoutes } from "../../src/api/admin/chat-history/routes";
import {
  getActiveEscalations,
  resolveEscalation,
  saveMessage,
  normalizeEscalationSourceFilter,
} from "../../src/api/admin/chat-history/chatHistoryRepository";

const mockGetPool = getPool as jest.MockedFunction<typeof getPool>;
const mockGetActiveEscalations = getActiveEscalations as jest.MockedFunction<typeof getActiveEscalations>;
const mockResolveEscalation = resolveEscalation as jest.MockedFunction<typeof resolveEscalation>;
const mockSaveMessage = saveMessage as jest.MockedFunction<typeof saveMessage>;
// chatHistoryRepository は automock されるため、routes.ts が呼ぶ
// normalizeEscalationSourceFilter も既定では undefined を返す jest.fn() になる。
// 実装と同じ「'all'指定時のみ'all'、それ以外は'user'」の挙動を与えて回帰を防ぐ
// (jest.clearAllMocks() は呼び出し履歴のみクリアし、mockImplementationは保持される)。
const mockNormalizeEscalationSourceFilter =
  normalizeEscalationSourceFilter as jest.MockedFunction<typeof normalizeEscalationSourceFilter>;
mockNormalizeEscalationSourceFilter.mockImplementation((value: unknown) =>
  value === "all" ? "all" : "user",
);

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
      mockGetActiveEscalations.mockResolvedValueOnce({
        escalations: [
          { id: "s1", tenant_id: "tenant-a", session_id: "sess-1", escalated_at: "2026-01-01T00:00:00Z", last_message_at: "2026-01-01T00:00:00Z", message_count: 3, first_message_preview: "help", source: "user" },
        ],
        total: 1,
      });
      const res = await request(app)
        .get("/v1/admin/chat-history/escalations")
        .set("Authorization", `Bearer ${SUPER_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.escalations).toHaveLength(1);
      // GID 1217808492496192: source未指定は既定で'user'(e2e等を除外)をrepositoryに渡す
      expect(mockGetActiveEscalations).toHaveBeenCalledWith(undefined, undefined, "user");
    });

    it("client_admin → 自テナントのみ 200", async () => {
      mockGetActiveEscalations.mockResolvedValueOnce({ escalations: [], total: 0 });
      const res = await request(app)
        .get("/v1/admin/chat-history/escalations")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(mockGetActiveEscalations).toHaveBeenCalledWith("tenant-a", undefined, "user");
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

    // 壊れやすいポイント: roleAuthMiddleware配線(D1a)が外れると、tenant_id空の
    // client_adminがリポジトリ層まで到達してしまう。実際のミドルウェア連鎖(mock無し)を
    // 通す統合テストで固定する — ルーティング単体テストでは検出できない再発パターン。
    it("[回帰] client_admin + tenant_id空文字 → roleAuthMiddlewareで403、resolveEscalationは呼ばれない", async () => {
      const emptyTenantToken = makeDevJwt({ app_metadata: { role: "client_admin", tenant_id: "" } });
      const res = await request(app)
        .patch("/v1/admin/chat-history/sessions/s1/resolve-escalation")
        .set("Authorization", `Bearer ${emptyTenantToken}`);
      expect(res.status).toBe(403);
      expect(mockResolveEscalation).not.toHaveBeenCalled();
    });

    it("[回帰] client_admin + tenant_idクレーム欠落 → 403、resolveEscalationは呼ばれない", async () => {
      const noTenantToken = makeDevJwt({ app_metadata: { role: "client_admin" } });
      const res = await request(app)
        .patch("/v1/admin/chat-history/sessions/s1/resolve-escalation")
        .set("Authorization", `Bearer ${noTenantToken}`);
      expect(res.status).toBe(403);
      expect(mockResolveEscalation).not.toHaveBeenCalled();
    });

    // 存在確認オラクル防止の確認: 「他テナントのセッション」も「存在しないセッション」も
    // resolveEscalation内部で同一のtenant_id述語付きWHEREにより false を返す設計なので、
    // レスポンスは区別不能な404で統一されているべき（evaluations/triggerとは対照的 —後述）。
    it("他テナントのセッションIDを指定 → 存在しない場合と同じ404（存在有無を漏らさない）", async () => {
      mockResolveEscalation.mockResolvedValueOnce(false); // tenant_id述語で0行 = 他テナント所有と同じ結果
      const res = await request(app)
        .patch("/v1/admin/chat-history/sessions/other-tenant-session/resolve-escalation")
        .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "セッションが見つかりません" });
    });

    it("トップレベルclaimのtenant_id（app_metadata外）は無視され、client_adminは403になる", async () => {
      // P1-2是正の回帰: su.tenant_id（トップレベル）はもう読まれないこと。
      const topLevelOnlyToken = makeDevJwt({
        role: "client_admin",
        tenant_id: "tenant-a", // トップレベル — app_metadata配下ではない
      });
      const res = await request(app)
        .patch("/v1/admin/chat-history/sessions/s1/resolve-escalation")
        .set("Authorization", `Bearer ${topLevelOnlyToken}`);
      // app_metadata.role が無いため isAllowedAdminRole すら通らず 403
      expect(res.status).toBe(403);
      expect(mockResolveEscalation).not.toHaveBeenCalled();
    });
  });
});
