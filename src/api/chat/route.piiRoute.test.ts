// src/api/chat/route.piiRoute.test.ts
// PR-9(R10救出): detectPiiRoute(src/agent/avatar/piiRouteDetector.ts)を
// 既存の L5/L7/L6 防御層の隣で呼び、結果を runDialogTurn の options.piiMode と
// chat_messages.metadata に流すことのテスト。detectPiiRoute 自体は
// src/agent/avatar/piiRouteDetector.test.ts で個別に検証する。
//
// createChatHandler は多数の依存を持つため、route.trafficSource.test.ts と
// 同じ方針でPII判定に関係しない部分は全てモックし、runDialogTurn/saveMessage
// 呼び出し引数のみを検証する。

import express from "express";
import request from "supertest";
import pino from "pino";

const mockSaveMessage = jest.fn().mockResolvedValue(undefined);
jest.mock("../admin/chat-history/chatHistoryRepository", () => ({
  saveMessage: (...args: unknown[]) => mockSaveMessage(...args),
}));

jest.mock("../admin/knowledge/knowledgeGapRepository", () => ({
  saveKnowledgeGap: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/billing/usageTracker", () => ({
  trackUsage: jest.fn(),
}));

jest.mock("../../lib/sentiment/client", () => ({
  analyzeSentiment: jest.fn().mockResolvedValue(null),
}));

const mockRunDialogTurn = jest.fn();
jest.mock("../../agent/dialog/dialogAgent", () => ({
  runDialogTurn: (...args: unknown[]) => mockRunDialogTurn(...args),
}));

jest.mock("../../agent/dialog/flowContextStore", () => ({
  peekFlowSessionMeta: jest.fn().mockReturnValue(undefined),
}));

jest.mock("../../agent/dialog/salesContextStore", () => ({
  getSalesSessionMeta: jest.fn().mockReturnValue(undefined),
}));

import { createChatHandler } from "./route";
import { requestIdMiddleware } from "../../lib/request-id";

function makeApp(opts: { tenantId?: string } = {}) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use((req: any, _res, next) => {
    req.tenantId = opts.tenantId ?? "tenant-1";
    req.lang = "ja";
    next();
  });
  const logger = pino({ level: "silent" });
  app.post("/api/chat", createChatHandler(logger));
  return app;
}

beforeEach(() => {
  mockSaveMessage.mockClear();
  mockRunDialogTurn.mockReset().mockResolvedValue({
    sessionId: "sess-1",
    answer: "かしこまりました。",
    needsClarification: false,
    steps: [],
    final: true,
    meta: {},
  });
});

describe("POST /api/chat — PII導線検知(detectPiiRoute)", () => {
  it("支払い関連の質問 → runDialogTurnにpiiMode=trueが渡り、user/assistant両方のmetadataにpiiRouteが記録される", async () => {
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "クレジットカードの請求について教えてください" });

    expect(mockRunDialogTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ piiMode: true }),
      })
    );

    await new Promise((r) => setTimeout(r, 20));
    const userCall = mockSaveMessage.mock.calls.find((c) => c[0].role === "user");
    const assistantCall = mockSaveMessage.mock.calls.find((c) => c[0].role === "assistant");
    expect(userCall?.[0].metadata).toEqual(
      expect.objectContaining({ piiRoute: true, piiReasons: expect.arrayContaining(["payment_billing"]) })
    );
    expect(assistantCall?.[0].metadata).toEqual(
      expect.objectContaining({ piiRoute: true, piiReasons: expect.arrayContaining(["payment_billing"]) })
    );
  });

  it("PIIに無関係な質問 → piiMode=falseが渡り、metadataにpiiRouteは含まれない", async () => {
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "営業時間を教えてください" });

    expect(mockRunDialogTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ piiMode: false }),
      })
    );

    await new Promise((r) => setTimeout(r, 20));
    const userCall = mockSaveMessage.mock.calls.find((c) => c[0].role === "user");
    expect(userCall?.[0].metadata).toBeUndefined();
  });

  it("クライアントが options.piiMode=false を送ってきても、PII該当メッセージなら無視してtrueが渡る(クライアント入力を信用しない)", async () => {
    await request(makeApp())
      .post("/api/chat")
      .send({
        message: "パスワードを忘れたのでアカウントを確認してください",
        options: { piiMode: false },
      });

    expect(mockRunDialogTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ piiMode: true }),
      })
    );
  });
});
