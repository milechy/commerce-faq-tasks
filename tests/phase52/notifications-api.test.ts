// tests/phase52/notifications-api.test.ts
// Phase52h: 通知センター API テスト

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
const mockPool = { query: (...args: any[]) => mockQuery(...args) };

jest.mock("../../src/lib/db", () => ({
  getPool: () => mockPool,
  pool: mockPool,
}));

jest.mock("../../src/admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import { registerNotificationRoutes } from "../../src/api/admin/notifications/routes";
import { createNotification, notificationExists } from "../../src/lib/notifications";

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

function makeApp(role: "super_admin" | "client_admin" = "super_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
    next();
  });
  registerNotificationRoutes(app);
  return app;
}

function makeUnauthApp() {
  const app = express();
  app.use(express.json());
  // No supabaseUser set — middleware will still call next() due to mock,
  // but role/tenantId will be empty strings
  registerNotificationRoutes(app);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// GET /v1/admin/notifications
// ---------------------------------------------------------------------------

describe("GET /v1/admin/notifications", () => {
  it("super_admin: 全通知を取得（role='super_admin' OR tenant IS NULL）", async () => {
    const notifItems = [
      { id: 1, type: "ai_rule_suggested", title: "テスト", message: "msg", is_read: false, created_at: new Date().toISOString() },
    ];
    // 1: unread count query
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "3" }] });
    // 2: total count query
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "1" }] });
    // 3: items query
    mockQuery.mockResolvedValueOnce({ rows: notifItems });

    const res = await request(makeApp("super_admin")).get("/v1/admin/notifications");
    expect(res.status).toBe(200);
    expect(res.body.unread_count).toBe(3);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].type).toBe("ai_rule_suggested");

    // super_admin では tenant_id パラメータなし
    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[0]).toContain("recipient_role = 'super_admin'");
    expect(firstCall[0]).toContain("recipient_tenant_id IS NULL");
    expect(firstCall[1]).toEqual([]); // no params for super_admin role clause
  });

  it("client_admin: 自テナント通知のみ取得", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "1" }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "1" }] });
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 2, type: "outcome_reminder", title: "未記録", message: "5件", is_read: false, created_at: new Date().toISOString() },
    ]});

    const res = await request(makeApp("client_admin", "tenant-b")).get("/v1/admin/notifications");
    expect(res.status).toBe(200);
    expect(res.body.items[0].type).toBe("outcome_reminder");

    // client_admin では tenant_id が $1 に入る
    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[0]).toContain("client_admin");
    expect(firstCall[1]).toContain("tenant-b");
  });

  it("?is_read=false フィルタが適用される", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "2" }] }); // unread
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: "2" }] }); // total with filter
    mockQuery.mockResolvedValueOnce({ rows: [] });              // items

    const res = await request(makeApp()).get("/v1/admin/notifications?is_read=false");
    expect(res.status).toBe(200);
    // is_read=false フィルタがクエリに含まれる
    const itemsCall = mockQuery.mock.calls[2];
    expect(itemsCall[0]).toContain("is_read = false");
  });

  it("テーブル未作成時(42P01)は空配列を返す", async () => {
    const pgError = Object.assign(new Error("table not found"), { code: "42P01" });
    mockQuery.mockRejectedValueOnce(pgError);

    const res = await request(makeApp()).get("/v1/admin/notifications");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], unread_count: 0, total: 0 });
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/admin/notifications/:id/read
// ---------------------------------------------------------------------------

describe("PATCH /v1/admin/notifications/:id/read", () => {
  it("正常: 個別既読に更新", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp("super_admin")).patch("/v1/admin/notifications/42/read");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain("UPDATE notifications SET is_read = true WHERE id = $1");
    expect(call[1]).toEqual([42]);
  });

  it("id が数値でない場合は 400", async () => {
    const res = await request(makeApp()).patch("/v1/admin/notifications/abc/read");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/admin/notifications/read-all
// ---------------------------------------------------------------------------

describe("PATCH /v1/admin/notifications/read-all", () => {
  it("super_admin: 全未読を既読に", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp("super_admin")).patch("/v1/admin/notifications/read-all");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain("recipient_role = 'super_admin'");
  });

  it("client_admin: 自テナントのみ既読に", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp("client_admin", "tenant-c")).patch("/v1/admin/notifications/read-all");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain("recipient_role = 'client_admin'");
    expect(call[1]).toContain("tenant-c");
  });
});

// ---------------------------------------------------------------------------
// createNotification ヘルパー
// ---------------------------------------------------------------------------

describe("createNotification", () => {
  it("正常INSERT: パラメータが正しく渡される", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await createNotification({
      recipientRole: "super_admin",
      type: "ai_rule_suggested",
      title: "新しいルール提案",
      message: "3件提案されました",
      link: "/admin/evaluations",
      metadata: { score: 45 },
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain("INSERT INTO notifications");
    expect(call[1][0]).toBe("super_admin");
    expect(call[1][2]).toBe("ai_rule_suggested");
    expect(call[1][3]).toBe("新しいルール提案");
  });

  it("DBエラー時も例外を投げない（fire-and-forget）", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB down"));

    await expect(
      createNotification({
        recipientRole: "super_admin",
        type: "test",
        title: "test",
        message: "test",
      })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// notificationExists: 重複チェック
// ---------------------------------------------------------------------------

describe("notificationExists", () => {
  it("同じ type + metadata key で既存通知あり → true", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const result = await notificationExists("conversion_rate_change", "week", "2026-W14");
    expect(result).toBe(true);

    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain("jsonb_extract_path_text");
    expect(call[1]).toEqual(["conversion_rate_change", "week", "2026-W14"]);
  });

  it("既存通知なし → false", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await notificationExists("outcome_reminder", "date", "2026-04-01");
    expect(result).toBe(false);
  });

  it("DBエラー時は false を返す（エラーは投げない）", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));

    const result = await notificationExists("any_type", "key", "value");
    expect(result).toBe(false);
  });
});
