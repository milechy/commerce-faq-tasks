// src/api/admin/chat-history/escalationsRoute.test.ts
// GID 1217808492496192: GET /v1/admin/chat-history/escalations の source クエリ
// パラメータ(e2e/内部テスト混入除外)の3点セット + 既定挙動テスト。

import express from "express";
import request from "supertest";
import { registerChatHistoryRoutes } from "./routes";

jest.mock("./chatHistoryRepository");
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

import { getActiveEscalations } from "./chatHistoryRepository";
const mockGetActiveEscalations = getActiveEscalations as jest.MockedFunction<typeof getActiveEscalations>;

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const CLIENT_ADMIN_TOKEN = makeDevJwt({
  email: "admin@example.com",
  app_metadata: { role: "client_admin", tenant_id: "tenant-a" },
});

describe("GET /v1/admin/chat-history/escalations", () => {
  let app: ReturnType<typeof express>;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    registerChatHistoryRoutes(app);
    mockGetActiveEscalations.mockResolvedValue({ escalations: [], total: 0 });
  });

  // ── 標準3点セット ─────────────────────────────────────────────────────────

  it("正常系: 認証済みclient_adminが対応中の一覧を取得できる", async () => {
    mockGetActiveEscalations.mockResolvedValueOnce({
      escalations: [
        {
          id: "s1",
          tenant_id: "tenant-a",
          session_id: "sess-1",
          escalated_at: "2026-01-01T00:00:00Z",
          last_message_at: "2026-01-01T00:00:00Z",
          message_count: 2,
          first_message_preview: "help",
          source: "user",
        },
      ],
      total: 1,
    });

    const res = await request(app)
      .get("/v1/admin/chat-history/escalations")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.escalations).toHaveLength(1);
  });

  it("認証エラー: JWT無しは401を返す", async () => {
    const res = await request(app).get("/v1/admin/chat-history/escalations");
    expect(res.status).toBe(401);
  });

  it("バリデーション: 不正な source値は既定の'user'として扱われエラーにしない", async () => {
    const res = await request(app)
      .get("/v1/admin/chat-history/escalations?source=not-a-valid-value")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockGetActiveEscalations).toHaveBeenCalledWith("tenant-a", undefined, "user");
  });

  // ── source フィルタの既定挙動 ────────────────────────────────────────────

  it("source未指定なら既定で'user'をrepositoryに渡す(e2e等は既定で除外)", async () => {
    const res = await request(app)
      .get("/v1/admin/chat-history/escalations")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockGetActiveEscalations).toHaveBeenCalledWith("tenant-a", undefined, "user");
  });

  it("source=allを明示すると'all'をrepositoryに渡す(e2e等も含めた全件)", async () => {
    const res = await request(app)
      .get("/v1/admin/chat-history/escalations?source=all")
      .set("Authorization", `Bearer ${CLIENT_ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockGetActiveEscalations).toHaveBeenCalledWith("tenant-a", undefined, "all");
  });
});
