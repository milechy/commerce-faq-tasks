// src/api/chat/route.ragCategory.test.ts
// LemonSliceペルソナスワップ(GID 1215698823592534): /api/chat が返す
// ChatMessage.ragCategory が result.meta.ragCategory から正しく転送されることのテスト。
//
// dialogAgent.test.ts は runDialogOrchestrator の戻り値 → meta.ragCategory までを
// 検証しているが、meta.ragCategory → HTTPレスポンスボディの ragCategory への
// 転送(route.ts側の配線)はどのテストにもカバーされていなかった。

import express from "express";
import request from "supertest";
import pino from "pino";

jest.mock("../admin/chat-history/chatHistoryRepository", () => ({
  saveMessage: jest.fn().mockResolvedValue(undefined),
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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use((req: any, _res, next) => {
    req.tenantId = "tenant-1";
    req.lang = "ja";
    next();
  });
  const logger = pino({ level: "silent" });
  app.post("/api/chat", createChatHandler(logger));
  return app;
}

function baseDialogResult(meta: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    answer: "こんにちは、ご質問ありがとうございます。",
    needsClarification: false,
    steps: [],
    final: true,
    meta,
  };
}

beforeEach(() => {
  mockRunDialogTurn.mockReset();
});

describe("POST /api/chat — ragCategory の応答転送", () => {
  it("meta.ragCategory があれば応答の ragCategory に転送される", async () => {
    mockRunDialogTurn.mockResolvedValue(baseDialogResult({ ragCategory: "fashion" }));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "このジャケットに合うスカートは？" });

    expect(res.status).toBe(200);
    expect(res.body.data.ragCategory).toBe("fashion");
  });

  it("meta.ragCategory が無ければ応答の ragCategory は undefined(欠落するがエラーにならない)", async () => {
    mockRunDialogTurn.mockResolvedValue(baseDialogResult({}));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(res.body.data.ragCategory).toBeUndefined();
  });

  it("meta 自体が undefined でも例外にならず ragCategory は含まれない", async () => {
    mockRunDialogTurn.mockResolvedValue({
      sessionId: "sess-1",
      answer: "こんにちは",
      needsClarification: false,
      steps: [],
      final: true,
      meta: undefined,
    });

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(res.body.data.ragCategory).toBeUndefined();
  });

  it("ragCategory が異常な型(数値)で来てもそのまま転送されるだけでクラッシュしない", async () => {
    // dialogAgent側の型はstringだが、meta はテスト外部からは型で守られていない
    // (Record<string, unknown>由来ではないがJSレベルの安全網として確認する)。
    mockRunDialogTurn.mockResolvedValue(baseDialogResult({ ragCategory: 12345 as unknown as string }));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(res.body.data.ragCategory).toBe(12345);
  });
});
