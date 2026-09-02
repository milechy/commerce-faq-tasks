// src/api/chat/route.messageId.test.ts
//
// 是正4-2(GID 1218086286324510): 👎 の message_ref が実メッセージ(chat_messages)と
// 紐づかない問題への対応の一部。/api/chat の応答に、保存できた assistant メッセージの
// 実DB主キー(chat_messages.id)を message_id として追加する(既存フィールドはそのまま、
// 追加のみ)。widget.js はこれを answer_feedback の message_ref として使う。

jest.mock("../admin/knowledge/knowledgeGapRepository", () => ({
  saveKnowledgeGap: jest.fn().mockResolvedValue(undefined),
}));

const mockSaveMessage = jest.fn();
jest.mock("../admin/chat-history/chatHistoryRepository", () => ({
  saveMessage: (...args: unknown[]) => mockSaveMessage(...args),
}));

const mockDetectGap = jest.fn().mockResolvedValue({ detected: false, source: null });
jest.mock("../../agent/gap/gapDetector", () => ({
  detectGap: (...args: unknown[]) => mockDetectGap(...args),
}));

jest.mock("../../lib/billing/usageTracker", () => ({
  trackUsage: jest.fn(),
}));

jest.mock("../../lib/sentiment/client", () => ({
  analyzeSentiment: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../agent/dialog/salesContextStore", () => ({
  getSalesSessionMeta: jest.fn().mockReturnValue(undefined),
}));

const mockRunDialogTurn = jest.fn();
jest.mock("../../agent/dialog/dialogAgent", () => ({
  runDialogTurn: (...args: unknown[]) => mockRunDialogTurn(...args),
}));

jest.mock("../../lib/hermesConsent", () => ({
  getCachedShareConsent: jest.fn().mockResolvedValue(undefined),
}));

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import pino from "pino";
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

function baseDialogResult() {
  return {
    sessionId: "sess-1",
    answer: "こんにちは、ご質問ありがとうございます。",
    needsClarification: false,
    steps: [],
    final: true,
    meta: {},
  };
}

beforeEach(() => {
  mockRunDialogTurn.mockReset().mockResolvedValue(baseDialogResult());
  mockSaveMessage.mockReset();
  mockDetectGap.mockClear();
});

describe("POST /api/chat — message_id(chat_messages.id)の応答転送(是正4-2)", () => {
  it("assistantメッセージの保存に成功したら、その実IDを message_id として返す", async () => {
    // 1回目の呼び出し(userメッセージ保存)はfire-and-forgetでID不要、
    // 2回目(assistantメッセージ保存)が応答に載せるべきID。
    mockSaveMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("4242");

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "在庫はありますか" });

    expect(res.status).toBe(200);
    expect(res.body.data.message_id).toBe("4242");
    // 既存フィールドは破壊されていない(追加のみ)
    expect(res.body.data.content).toBeTruthy();
    expect(res.body.data.role).toBe("assistant");
    expect(typeof res.body.data.id).toBe("string");
  });

  it("assistantメッセージの保存がidを返さない(旧経路/未解決)場合、message_idは省略される", async () => {
    mockSaveMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "在庫はありますか" });

    expect(res.status).toBe(200);
    expect(res.body.data.message_id).toBeUndefined();
    expect(res.body.data.content).toBeTruthy();
  });

  it("異常系: assistantメッセージの保存が例外を投げてもチャット応答は止めない(message_idは省略)", async () => {
    mockSaveMessage
      .mockResolvedValueOnce(undefined) // user保存
      .mockRejectedValueOnce(new Error("connection refused")); // assistant保存

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "在庫はありますか" });

    expect(res.status).toBe(200);
    expect(res.body.data.content).toBeTruthy();
    expect(res.body.data.message_id).toBeUndefined();
  });
});
