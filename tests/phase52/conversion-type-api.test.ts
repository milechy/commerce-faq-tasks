// tests/phase52/conversion-type-api.test.ts
// Phase52f Phase A: コンバージョンタイプAPI + outcome記録APIのテスト

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();

jest.mock("../../src/lib/db", () => ({
  getPool: () => ({ query: (...args: any[]) => mockQuery(...args) }),
  pool: { query: (...args: any[]) => mockQuery(...args) },
}));

jest.mock("../../src/admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import { registerChatHistoryRoutes } from "../../src/api/admin/chat-history/routes";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(role: Role = "client_admin", tenantId = "tenant-a", email = "admin@example.com") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      email,
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });
  registerChatHistoryRoutes(app);
  return app;
}

function makeUnauthApp() {
  const app = express();
  app.use(express.json());
  // no supabaseUser
  registerChatHistoryRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SESSION_ROW = {
  id: "sess-uuid-001",
  tenant_id: "tenant-a",
};

const TENANT_ROW_WITH_TYPES = {
  conversion_types: ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"],
};

// ---------------------------------------------------------------------------
// 1. 正常系: outcome記録
// ---------------------------------------------------------------------------
describe("1. 正常系 — outcome記録", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce({ rows: [SESSION_ROW] })        // chat_sessions lookup
      .mockResolvedValueOnce({ rows: [TENANT_ROW_WITH_TYPES] }) // tenants conversion_types
      .mockResolvedValueOnce({ rows: [] });                   // UPDATE chat_sessions
  });

  it("200 + outcome + recorded_at を返す", async () => {
    const res = await request(makeApp())
      .patch("/v1/admin/chat-history/sessions/sess-uuid-001/outcome")
      .send({ outcome: "購入完了" });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("購入完了");
    expect(res.body.sessionId).toBe("sess-uuid-001");
    expect(res.body.recorded_at).toBeDefined();
  });

  it("recorded_by にemailが入る", async () => {
    const res = await request(makeApp("client_admin", "tenant-a", "user@example.com"))
      .patch("/v1/admin/chat-history/sessions/sess-uuid-001/outcome")
      .send({ outcome: "購入完了" });

    expect(res.status).toBe(200);
    expect(res.body.recorded_by).toBe("user@example.com");
  });
});

// ---------------------------------------------------------------------------
// 2. conversion_typesに含まれない値 → 400
// ---------------------------------------------------------------------------
describe("2. 無効なoutcome → 400", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce({ rows: [SESSION_ROW] })
      .mockResolvedValueOnce({ rows: [TENANT_ROW_WITH_TYPES] });
  });

  it("returns 400 with valid_outcomes", async () => {
    const res = await request(makeApp())
      .patch("/v1/admin/chat-history/sessions/sess-uuid-001/outcome")
      .send({ outcome: "無効な値" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conversion_types/);
    expect(res.body.valid_outcomes).toEqual(TENANT_ROW_WITH_TYPES.conversion_types);
  });
});

// ---------------------------------------------------------------------------
// 3. client_admin 他テナントのセッション → 403
// ---------------------------------------------------------------------------
describe("3. client_admin 他テナント → 403", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...SESSION_ROW, tenant_id: "tenant-b" }] });
  });

  it("returns 403", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .patch("/v1/admin/chat-history/sessions/sess-uuid-001/outcome")
      .send({ outcome: "購入完了" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 4. セッション未存在 → 404
// ---------------------------------------------------------------------------
describe("4. セッション未存在 → 404", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValueOnce({ rows: [] });
  });

  it("returns 404", async () => {
    const res = await request(makeApp())
      .patch("/v1/admin/chat-history/sessions/nonexistent/outcome")
      .send({ outcome: "購入完了" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 5. outcomeなし → 400
// ---------------------------------------------------------------------------
describe("5. outcomeパラメータなし → 400", () => {
  it("returns 400", async () => {
    const res = await request(makeApp())
      .patch("/v1/admin/chat-history/sessions/sess-uuid-001/outcome")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outcome/);
  });
});

// ---------------------------------------------------------------------------
// 6. super_admin は他テナントのセッションにもアクセス可
// ---------------------------------------------------------------------------
describe("6. super_admin 他テナントのセッション → 200", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...SESSION_ROW, tenant_id: "tenant-b" }] })
      .mockResolvedValueOnce({ rows: [TENANT_ROW_WITH_TYPES] })
      .mockResolvedValueOnce({ rows: [] });
  });

  it("returns 200", async () => {
    const res = await request(makeApp("super_admin", "tenant-a"))
      .patch("/v1/admin/chat-history/sessions/sess-uuid-001/outcome")
      .send({ outcome: "購入完了" });

    expect(res.status).toBe(200);
  });
});
