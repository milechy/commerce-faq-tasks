// src/api/chat/route.dataSharedExternally.test.ts
// S6(共有学習プールの参加モデル・fail-open是正): ChatMessage.data_shared_externally が
// getCachedShareConsent から正しく転送されることのテスト。
//
// 背景: 開示バナー(ウィジェットのconsent-banner)は本来 /api/widget/features の
// 応答で出す。その取得に失敗すると share=true のテナントでも開示が一切出ない
// (fail-open)。/api/chat は会話が成立する限り必ず1往復あるため、この応答にも
// 同じ判定を載せてバックストップにした。ragCategory と同じ「meta→レスポンス転送」
// パターンだが、data_shared_externallyは meta 経由ではなく getCachedShareConsent を
// 直接 await する形のため、専用ファイルで検証する。

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

jest.mock("../../agent/dialog/salesContextStore", () => ({
  getSalesSessionMeta: jest.fn().mockReturnValue(undefined),
}));

const mockRunDialogTurn = jest.fn();
jest.mock("../../agent/dialog/dialogAgent", () => ({
  runDialogTurn: (...args: unknown[]) => mockRunDialogTurn(...args),
}));

const mockGetCachedShareConsent = jest.fn();
jest.mock("../../lib/hermesConsent", () => ({
  getCachedShareConsent: (...args: unknown[]) => mockGetCachedShareConsent(...args),
}));

import { createChatHandler } from "./route";
import { requestIdMiddleware } from "../../lib/request-id";

function makeApp(tenantId = "tenant-1") {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use((req: any, _res, next) => {
    req.tenantId = tenantId;
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
  mockGetCachedShareConsent.mockReset();
});

describe("POST /api/chat — data_shared_externally の応答転送(S6)", () => {
  it("share=true のテナントは data_shared_externally: true を返す", async () => {
    mockGetCachedShareConsent.mockResolvedValue(true);

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(res.body.data.data_shared_externally).toBe(true);
  });

  it("share=false のテナントは data_shared_externally: false を返す(trueへ誤って倒れない)", async () => {
    mockGetCachedShareConsent.mockResolvedValue(false);

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(res.body.data.data_shared_externally).toBe(false);
  });

  it("正しいtenantIdでgetCachedShareConsentが呼ばれる(他テナントの値を混同しない)", async () => {
    mockGetCachedShareConsent.mockResolvedValue(true);

    await request(makeApp("carnation"))
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(mockGetCachedShareConsent).toHaveBeenCalledWith("carnation");
  });

  it("異常系(fail-open是正の核心): getCachedShareConsentが例外を投げてもチャット応答は止めない", async () => {
    mockGetCachedShareConsent.mockRejectedValue(new Error("connection refused"));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    // チャット自体は成立する(これが最優先。開示判定の失敗で会話を止めない)。
    expect(res.status).toBe(200);
    expect(res.body.data.content).toBeTruthy();
  });

  it("異常系: getCachedShareConsentが例外を投げた場合、data_shared_externallyはundefined(誤ってfalseと断定しない)", async () => {
    // ここは意図的な設計判断の固定: 判定不能を「共有していない(false)」と混同すると、
    // 実際には共有しているのに開示しない、という最悪の方向に倒れかねない。
    // route.ts側はtry/catchでundefinedのまま握りつぶし、trueともfalseとも
    // 断定しない(widget側はundefinedを「バックストップとしては出さない」と
    // 扱うが、features側の応答が別途生きていれば通常どおり出せる)。
    mockGetCachedShareConsent.mockRejectedValue(new Error("timeout"));

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    expect(res.status).toBe(200);
    expect(res.body.data.data_shared_externally).toBeUndefined();
  });

  it("userロールのメッセージには影響しない(assistantメッセージのみに載る契約の確認)", async () => {
    mockGetCachedShareConsent.mockResolvedValue(true);

    const res = await request(makeApp())
      .post("/api/chat")
      .send({ message: "こんにちは" });

    // レスポンスは常に assistant の1件のみを返す(userメッセージはechoしない)契約を
    // 前提に、data配下のroleがassistantであることを確認する。
    expect(res.body.data.role).toBe("assistant");
  });
});
