// src/api/chat/route.trafficSource.test.ts
// GID 1216970103691946: /api/chat が saveMessage() に渡す trafficSource の判定テスト
//
// createChatHandler は多数の依存(agent orchestrator / sentiment / security層)を持つため、
// トラフィックソース判定に関係しない部分は全てモックし、saveMessage() 呼び出し引数のみを検証する。

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

function makeApp(opts: { tenantId?: string; isChatTestToken?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use((req: any, _res, next) => {
    req.tenantId = opts.tenantId ?? "tenant-1";
    req.lang = "ja";
    if (opts.isChatTestToken) req.isChatTestToken = true;
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
    answer: "こんにちは、ご質問ありがとうございます。",
    needsClarification: false,
    steps: [],
    final: true,
    meta: {},
  });
});

describe("POST /api/chat — trafficSource判定", () => {
  it("x-r2c-traffic-source: e2e ヘッダあり → saveMessageにtrafficSource='e2e'を渡す", async () => {
    await request(makeApp())
      .post("/api/chat")
      .set("x-r2c-traffic-source", "e2e")
      .send({ message: "こんにちは" });

    expect(mockSaveMessage).toHaveBeenCalled();
    for (const call of mockSaveMessage.mock.calls) {
      expect(call[0].trafficSource).toBe("e2e");
    }
  });

  it("ヘッダなし・UAがHeadlessChrome → saveMessageにtrafficSource='e2e'を渡す", async () => {
    await request(makeApp())
      .post("/api/chat")
      .set("User-Agent", "Mozilla/5.0 HeadlessChrome/120.0.0.0")
      .send({ message: "こんにちは" });

    expect(mockSaveMessage).toHaveBeenCalled();
    for (const call of mockSaveMessage.mock.calls) {
      expect(call[0].trafficSource).toBe("e2e");
    }
  });

  it("chat-test経由(req.isChatTestToken=true) → saveMessageにtrafficSource='chat_test'を渡す", async () => {
    await request(makeApp({ isChatTestToken: true }))
      .post("/api/chat")
      .send({ message: "テスト送信です" });

    expect(mockSaveMessage).toHaveBeenCalled();
    for (const call of mockSaveMessage.mock.calls) {
      expect(call[0].trafficSource).toBe("chat_test");
    }
  });

  it("通常のブラウザリクエスト(ヘッダ・UAとも通常) → saveMessageにtrafficSource='user'を渡す", async () => {
    await request(makeApp())
      .post("/api/chat")
      .set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")
      .send({ message: "こんにちは" });

    expect(mockSaveMessage).toHaveBeenCalled();
    for (const call of mockSaveMessage.mock.calls) {
      expect(call[0].trafficSource).toBe("user");
    }
  });

  it("user/assistant両方のsaveMessage呼び出しに同じtrafficSourceが渡る", async () => {
    await request(makeApp())
      .post("/api/chat")
      .set("x-r2c-traffic-source", "e2e")
      .send({ message: "こんにちは" });

    // Phase38: user保存(同期) + assistant保存(非同期、レスポンス後) の2回呼ばれる
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSaveMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
    const sources = mockSaveMessage.mock.calls.map((c) => c[0].trafficSource);
    expect(new Set(sources)).toEqual(new Set(["e2e"]));
  });
});
