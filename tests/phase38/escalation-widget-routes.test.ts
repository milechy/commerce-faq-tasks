// tests/phase38/escalation-widget-routes.test.ts
// GID 1216275508391900: 有人チャットへのシームレスエスカレーション — Widget向けAPI

jest.mock("../../src/api/admin/chat-history/chatHistoryRepository");
jest.mock("../../src/lib/notifications");

import express from "express";
import request from "supertest";
import { registerEscalationRoutes } from "../../src/api/chat/escalationRoutes";
import {
  escalateSession,
  getNewOperatorMessages,
} from "../../src/api/admin/chat-history/chatHistoryRepository";
import { createNotification } from "../../src/lib/notifications";

const mockEscalateSession = escalateSession as jest.MockedFunction<typeof escalateSession>;
const mockGetNewOperatorMessages = getNewOperatorMessages as jest.MockedFunction<typeof getNewOperatorMessages>;
const mockCreateNotification = createNotification as jest.MockedFunction<typeof createNotification>;

function makeApp(tenantId: string | undefined = "tenant-a") {
  const app = express();
  app.use(express.json());
  const apiStack = [
    (req: any, _res: any, next: any) => {
      if (tenantId) req.tenantId = tenantId;
      next();
    },
  ];
  registerEscalationRoutes(app, apiStack);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe("POST /api/chat/escalate", () => {
  it("正常系(新規エスカレーション) → 200 + 通知2件発行", async () => {
    mockEscalateSession.mockResolvedValueOnce({ dbSessionId: "s1", alreadyEscalated: false });
    const app = makeApp("tenant-a");
    const res = await request(app).post("/api/chat/escalate").send({ sessionId: "conv-1" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.already_escalated).toBe(false);
    expect(mockEscalateSession).toHaveBeenCalledWith({ tenantId: "tenant-a", sessionId: "conv-1" });
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it("既にエスカレーション済み → 通知は発行しない(冪等)", async () => {
    mockEscalateSession.mockResolvedValueOnce({ dbSessionId: "s1", alreadyEscalated: true });
    const app = makeApp("tenant-a");
    const res = await request(app).post("/api/chat/escalate").send({ sessionId: "conv-1" });
    expect(res.status).toBe(200);
    expect(res.body.already_escalated).toBe(true);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("sessionId欠如 → 400", async () => {
    const app = makeApp("tenant-a");
    const res = await request(app).post("/api/chat/escalate").send({});
    expect(res.status).toBe(400);
    expect(mockEscalateSession).not.toHaveBeenCalled();
  });

  it("tenantId未解決(認証なし相当) → 401", async () => {
    const app = makeApp("");
    const res = await request(app).post("/api/chat/escalate").send({ sessionId: "conv-1" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/chat/poll", () => {
  it("正常系 → 200 + operatorメッセージ配列", async () => {
    mockGetNewOperatorMessages.mockResolvedValueOnce([
      { id: 1, role: "operator", content: "担当します", metadata: {}, created_at: "2026-01-01T00:00:00Z" },
    ]);
    const app = makeApp("tenant-a");
    const res = await request(app).get("/api/chat/poll").query({ sessionId: "conv-1" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(mockGetNewOperatorMessages).toHaveBeenCalledWith({ tenantId: "tenant-a", sessionId: "conv-1", since: undefined });
  });

  it("sinceパラメータを渡す", async () => {
    mockGetNewOperatorMessages.mockResolvedValueOnce([]);
    const app = makeApp("tenant-a");
    await request(app).get("/api/chat/poll").query({ sessionId: "conv-1", since: "2026-01-01T00:00:00Z" });
    expect(mockGetNewOperatorMessages).toHaveBeenCalledWith({ tenantId: "tenant-a", sessionId: "conv-1", since: "2026-01-01T00:00:00Z" });
  });

  it("sessionId欠如 → 400", async () => {
    const app = makeApp("tenant-a");
    const res = await request(app).get("/api/chat/poll");
    expect(res.status).toBe(400);
  });

  it("tenantId未解決 → 401", async () => {
    const app = makeApp("");
    const res = await request(app).get("/api/chat/poll").query({ sessionId: "conv-1" });
    expect(res.status).toBe(401);
  });
});
