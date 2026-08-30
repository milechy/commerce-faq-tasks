// src/api/admin/chat-history/visitorData.route.test.ts
// GDPR visitor 単位: エクスポート(GET)/削除(DELETE) のルート検証。

import express from "express";
import { request } from "../../../../tests/helpers/testServer";
import { registerChatHistoryRoutes } from "./routes";

jest.mock("./visitorDataRepository");
jest.mock("../../../lib/db");
jest.mock("../../../lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), fatal: jest.fn(), child: jest.fn() },
}));

import { exportVisitorData, deleteVisitorData } from "./visitorDataRepository";
const mockExport = exportVisitorData as jest.MockedFunction<typeof exportVisitorData>;
const mockDelete = deleteVisitorData as jest.MockedFunction<typeof deleteVisitorData>;

function makeDevJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.devtest`;
}

const CLIENT_ADMIN = makeDevJwt({ email: "admin@example.com", app_metadata: { role: "client_admin", tenant_id: "tenant-a" } });
const SUPER_ADMIN = makeDevJwt({ email: "super@example.com", app_metadata: { role: "super_admin" } });
const VIEWER = makeDevJwt({ email: "v@example.com", app_metadata: { role: "viewer", tenant_id: "tenant-a" } });
const REASON = "GDPR削除請求に基づく処理";

describe("visitor GDPR routes", () => {
  let app: ReturnType<typeof express>;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_INSECURE_DEV_AUTH = "1";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    registerChatHistoryRoutes(app);
  });

  describe("GET /visitors/:visitorId/export", () => {
    it("client_admin: 自テナントで export できる", async () => {
      mockExport.mockResolvedValueOnce({
        tenant_id: "tenant-a", visitor_id: "vid-1", exported_at: "x", session_count: 1, message_count: 2, sessions: [],
      });
      const res = await request(app)
        .get("/v1/admin/chat-history/visitors/vid-1/export")
        .set("Authorization", `Bearer ${CLIENT_ADMIN}`);
      expect(res.status).toBe(200);
      expect(res.body.visitor_id).toBe("vid-1");
      expect(mockExport).toHaveBeenCalledWith({ tenantId: "tenant-a", visitorId: "vid-1" });
    });

    it("super_admin: tenant 未指定は 400", async () => {
      const res = await request(app)
        .get("/v1/admin/chat-history/visitors/vid-1/export")
        .set("Authorization", `Bearer ${SUPER_ADMIN}`);
      expect(res.status).toBe(400);
      expect(mockExport).not.toHaveBeenCalled();
    });

    it("super_admin: ?tenant 指定で export できる", async () => {
      mockExport.mockResolvedValueOnce({
        tenant_id: "tenant-z", visitor_id: "vid-1", exported_at: "x", session_count: 0, message_count: 0, sessions: [],
      });
      const res = await request(app)
        .get("/v1/admin/chat-history/visitors/vid-1/export?tenant=tenant-z")
        .set("Authorization", `Bearer ${SUPER_ADMIN}`);
      expect(res.status).toBe(200);
      expect(mockExport).toHaveBeenCalledWith({ tenantId: "tenant-z", visitorId: "vid-1" });
    });

    it("権限のないロールは 403", async () => {
      const res = await request(app)
        .get("/v1/admin/chat-history/visitors/vid-1/export")
        .set("Authorization", `Bearer ${VIEWER}`);
      expect(res.status).toBe(403);
      expect(mockExport).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /visitors/:visitorId", () => {
    it("client_admin: 削除できる", async () => {
      mockDelete.mockResolvedValueOnce({
        tenant_id: "tenant-a", visitor_id: "vid-1",
        affected_counts: { chat_sessions: 2, chat_messages: 9, option_orders_nulled: 0 },
      });
      const res = await request(app)
        .delete("/v1/admin/chat-history/visitors/vid-1")
        .set("Authorization", `Bearer ${CLIENT_ADMIN}`)
        .send({ reason: REASON });
      expect(res.status).toBe(200);
      expect(res.body.affected_counts.chat_sessions).toBe(2);
      expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", visitorId: "vid-1", reason: REASON }));
    });

    it("reason 不足は 400", async () => {
      const res = await request(app)
        .delete("/v1/admin/chat-history/visitors/vid-1")
        .set("Authorization", `Bearer ${CLIENT_ADMIN}`)
        .send({ reason: "x" });
      expect(res.status).toBe(400);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("super_admin: tenant 未指定は 400", async () => {
      const res = await request(app)
        .delete("/v1/admin/chat-history/visitors/vid-1")
        .set("Authorization", `Bearer ${SUPER_ADMIN}`)
        .send({ reason: REASON });
      expect(res.status).toBe(400);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
