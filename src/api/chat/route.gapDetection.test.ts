// src/api/chat/route.gapDetection.test.ts
//
// ナレッジ配線是正 P10 (Asana GID 1217811058060518):
// chat/route.ts はナレッジギャップ検出の第2の書き込み経路(直接 saveKnowledgeGap)
// を持っており、synthesisTool.ts の detectGap 呼び出し(同じ gapSignal)と重複して
// 同一メッセージの frequency を二重加算していた(upsertGap は7日以内ILIKE一致の
// 既存行に+1するため)。detectGap に一本化し、chat/route.ts 側は
// 「ヒットはあり信頼度も十分だったのに、LLM応答文面が未回答を示している」
// (synthesisTool.ts 側では検出できない固有の信号)のみを templateSource='fallback'
// として拾う。

jest.mock("../admin/chat-history/chatHistoryRepository", () => ({
  saveMessage: jest.fn().mockResolvedValue(undefined),
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

const mockRunDialogTurn = jest.fn();
jest.mock("../../agent/dialog/dialogAgent", () => ({
  runDialogTurn: (...args: unknown[]) => mockRunDialogTurn(...args),
}));

jest.mock("../../agent/dialog/salesContextStore", () => ({
  getSalesSessionMeta: jest.fn().mockReturnValue(undefined),
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

function dialogResult(answer: string, gapSignal?: { hitCount: number; topScore: number }) {
  return {
    sessionId: "sess-1",
    answer,
    needsClarification: false,
    steps: [],
    final: true,
    meta: { gapSignal },
  };
}

async function flushMicrotasks() {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  mockRunDialogTurn.mockReset();
  mockDetectGap.mockClear();
});

describe("POST /api/chat — ギャップ検出は detectGap に一本化(第2の書き込み経路を持たない)", () => {
  it("ヒット0件(no_rag相当)では detectGap を呼ばない(synthesisTool側が既に検出済みのため)", async () => {
    mockRunDialogTurn.mockResolvedValue(
      dialogResult("ご質問の内容に完全に一致するFAQは見つかりませんでした。", { hitCount: 0, topScore: 0 }),
    );

    await request(makeApp()).post("/api/chat").send({ message: "テスト質問" });
    await flushMicrotasks();

    expect(mockDetectGap).not.toHaveBeenCalled();
  });

  it("低信頼度(low_confidence相当)では detectGap を呼ばない(synthesisTool側が既に検出済みのため)", async () => {
    mockRunDialogTurn.mockResolvedValue(
      dialogResult("こちらでお調べした限りでは詳しい情報がございません。", { hitCount: 2, topScore: 0.1 }),
    );

    await request(makeApp()).post("/api/chat").send({ message: "テスト質問" });
    await flushMicrotasks();

    expect(mockDetectGap).not.toHaveBeenCalled();
  });

  it("ヒットあり・高信頼度なのに応答文面が未回答を示す場合のみ detectGap を fallback として呼ぶ", async () => {
    mockRunDialogTurn.mockResolvedValue(
      dialogResult("記載がありません。担当者にお問い合わせください。", { hitCount: 3, topScore: 0.8 }),
    );

    await request(makeApp()).post("/api/chat").send({ message: "テスト質問" });
    await flushMicrotasks();

    expect(mockDetectGap).toHaveBeenCalledTimes(1);
    const call = mockDetectGap.mock.calls[0]![0];
    expect(call.templateSource).toBe("fallback");
    expect(call.ragResultCount).toBe(3);
  });

  it("ヒットあり・高信頼度・正常回答なら detectGap を呼ばない", async () => {
    mockRunDialogTurn.mockResolvedValue(
      dialogResult("送料は全国一律500円です。", { hitCount: 3, topScore: 0.8 }),
    );

    await request(makeApp()).post("/api/chat").send({ message: "送料について" });
    await flushMicrotasks();

    expect(mockDetectGap).not.toHaveBeenCalled();
  });
});
