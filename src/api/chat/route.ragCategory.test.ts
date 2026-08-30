// src/api/chat/route.ragCategory.test.ts
// LemonSliceペルソナスワップ(GID 1215698823592534): /api/chat が返す
// ChatMessage.ragCategory が result.meta.ragCategory から正しく転送されることのテスト。
//
// dialogAgent.test.ts は runDialogOrchestrator の戻り値 → meta.ragCategory までを
// 検証しているが、meta.ragCategory → HTTPレスポンスボディの ragCategory への
// 転送(route.ts側の配線)はどのテストにもカバーされていなかった。

import express from "express";
import { request } from "../../../tests/helpers/testServer";
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

jest.mock("../../agent/dialog/salesContextStore", () => ({
  getSalesSessionMeta: jest.fn().mockReturnValue(undefined),
}));

import { createChatHandler } from "./route";
import { requestIdMiddleware } from "../../lib/request-id";
import { trackUsage } from "../../lib/billing/usageTracker";

const mockTrackUsage = trackUsage as jest.MockedFunction<typeof trackUsage>;

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
  mockTrackUsage.mockReset();
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

// PR-2(2026-08-25収益監査): meta.embeddingUsage → trackUsage の extraLlmUsages への
// 配線(route.ts側)はどのテストにもカバーされていなかった。以前は searchAgent.ts が
// embeddingトークンを chat モデルの prompt_tokens に直接合算していたため、
// embedding($0.02/1M)が chat モデル(はるかに高レート)で計上され、かつ
// embedTextWithUsage 自身が別途 tenant_id='unknown' の行も作っていた(二重計上)。
describe("POST /api/chat — embeddingUsage の extraLlmUsages 配線 (PR-2)", () => {
  it("meta.embeddingUsageがあればextraLlmUsagesに実モデル名で内包される", async () => {
    mockRunDialogTurn.mockResolvedValue(
      baseDialogResult({
        llmUsage: { prompt_tokens: 100, completion_tokens: 30 },
        embeddingUsage: { model: "text-embedding-3-small", totalTokens: 12 },
      }),
    );

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "送料について" });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        featureUsed: "chat",
        inputTokens: 100, // embeddingトークン(12)を含まない
        outputTokens: 30,
        extraLlmUsages: [{ model: "text-embedding-3-small", inputTokens: 12, outputTokens: 0 }],
      }),
    );
  });

  it("meta.embeddingUsageが無ければextraLlmUsagesは空のまま(plannerLlmUsagesと共存する)", async () => {
    mockRunDialogTurn.mockResolvedValue(
      baseDialogResult({
        llmUsage: { prompt_tokens: 50, completion_tokens: 10 },
        plannerLlmUsages: [{ model: "openai/gpt-oss-20b", prompt_tokens: 20, completion_tokens: 5 }],
      }),
    );

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    const call = mockTrackUsage.mock.calls[0]![0];
    expect(call.extraLlmUsages).toEqual([
      { model: "openai/gpt-oss-20b", inputTokens: 20, outputTokens: 5 },
    ]);
  });

  it("embeddingUsage.totalTokensが0ならextraLlmUsagesに含めない", async () => {
    mockRunDialogTurn.mockResolvedValue(
      baseDialogResult({
        llmUsage: { prompt_tokens: 100, completion_tokens: 30 },
        embeddingUsage: { model: "text-embedding-3-small", totalTokens: 0 },
      }),
    );

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "送料について" });

    expect(res.status).toBe(200);
    const call = mockTrackUsage.mock.calls[0]![0];
    expect(call.extraLlmUsages ?? []).toEqual([]);
  });
});
