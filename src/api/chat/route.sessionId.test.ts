// src/api/chat/route.sessionId.test.ts
// /api/chat のセッションID確定ロジックの回帰テスト。
//
// session_id は chat_sessions の upsert キー(ON CONFLICT (tenant_id, session_id))であり、
// かつ A/B variant の stickyKey でもある。ここが空文字や重複値になると
//   1. 別々の訪問者の会話が1つのセッション行にマージされる
//   2. variant が1会話の中で振り直される(CLAUDE.md 禁止36)
// という2つの実害が同時に出るため、境界での確定ロジックを固定する。

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

jest.mock("../../lib/billing/usageTracker", () => ({ trackUsage: jest.fn() }));
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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use((req: any, _res, next) => {
    req.tenantId = "tenant-1";
    req.lang = "ja";
    next();
  });
  app.post("/api/chat", createChatHandler(pino({ level: "silent" })));
  return app;
}

/** saveMessage に渡された sessionId を全件返す(user/assistant 両方)。 */
function savedSessionIds(): string[] {
  return mockSaveMessage.mock.calls.map((c) => c[0].sessionId);
}

/** runDialogTurn に渡された sessionId。variant の stickyKey はこれに由来する。 */
function dialogSessionId(): unknown {
  return mockRunDialogTurn.mock.calls[0]?.[0]?.sessionId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  mockSaveMessage.mockClear();
  mockRunDialogTurn.mockReset().mockResolvedValue({
    sessionId: "sess-1",
    answer: "ご質問ありがとうございます。",
    needsClarification: false,
    steps: [],
    final: true,
    meta: {},
  });
});

describe("POST /api/chat — sessionId の確定", () => {
  it("正常系: クライアント指定の sessionId をそのまま使う", async () => {
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", sessionId: "client-session-abc" });

    expect(savedSessionIds().every((s) => s === "client-session-abc")).toBe(true);
    expect(dialogSessionId()).toBe("client-session-abc");
  });

  it("正常系: sessionId 未指定なら conversationId を使う", async () => {
    const convId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", conversationId: convId });

    expect(savedSessionIds().every((s) => s === convId)).toBe(true);
  });

  it("正常系: どちらも未指定なら新規UUIDを生成する", async () => {
    await request(makeApp()).post("/api/chat").send({ message: "こんにちは" });

    const ids = savedSessionIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toMatch(UUID_RE);
    expect(new Set(ids).size).toBe(1); // 同一リクエスト内では1つに固定
  });

  it("回帰: sessionId が空文字なら空文字のまま使わず、新規UUIDを生成する", async () => {
    // zod は max(128) のみで min(1) が無いため "" は検証を通過する。
    // ?? は null/undefined しか拾わないため、以前は "" がそのまま
    // chat_sessions の upsert キーになっていた。
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", sessionId: "" });

    const ids = savedSessionIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).not.toBe("");
      expect(id).toMatch(UUID_RE);
    }
  });

  it("回帰: sessionId が空白のみでも空白のまま使わず、新規UUIDを生成する", async () => {
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", sessionId: "   " });

    for (const id of savedSessionIds()) {
      expect(id.trim()).not.toBe("");
      expect(id).toMatch(UUID_RE);
    }
  });

  it("回帰: 空 sessionId を送った別々のリクエストが同じセッションを共有しない", async () => {
    // chat_sessions は ON CONFLICT (tenant_id, session_id) で upsert するため、
    // 全員が "" を使うと1行に集約され、別々の訪問者の会話が1本にマージされる。
    const app = makeApp();

    await request(app).post("/api/chat").send({ message: "訪問者Aの質問", sessionId: "" });
    const first = savedSessionIds()[0]!;

    mockSaveMessage.mockClear();
    await request(app).post("/api/chat").send({ message: "訪問者Bの質問", sessionId: "" });
    const second = savedSessionIds()[0]!;

    expect(first).not.toBe(second);
  });

  it("回帰: 空 sessionId でも runDialogTurn には空でないIDが渡る(variantのstickyKeyが乱数に落ちない)", async () => {
    // selectVariant は stickyKey が falsy だと Math.random() に落ち、
    // 1会話の中で variant が振り直される(CLAUDE.md 禁止36)。
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", sessionId: "" });

    const sid = dialogSessionId();
    expect(typeof sid).toBe("string");
    expect(sid).not.toBe("");
    expect(sid).toMatch(UUID_RE);
  });

  it("空 sessionId かつ conversationId 指定時は conversationId を優先する(UUIDを無駄に作らない)", async () => {
    const convId = "3f2504e0-4f89-11d3-9a0c-0305e82c3399";
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", sessionId: "", conversationId: convId });

    expect(savedSessionIds().every((s) => s === convId)).toBe(true);
  });

  it("同一リクエスト内では user/assistant 両方の保存に同じ sessionId が使われる", async () => {
    await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", sessionId: "stable-session" });

    const ids = savedSessionIds();
    expect(ids.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(new Set(ids).size).toBe(1);
  });

  it("128文字ちょうどの sessionId は許容される(境界)", async () => {
    const long = "a".repeat(128);
    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", sessionId: long });

    expect(res.status).toBe(200);
    expect(savedSessionIds().every((s) => s === long)).toBe(true);
  });

  it("129文字の sessionId は 400 で弾かれ、DBに書き込まれない(境界)", async () => {
    const tooLong = "a".repeat(129);
    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは", sessionId: tooLong });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });
});
