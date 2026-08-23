// src/agent/memory/memoryDistiller.test.ts
// Phase71-A: memoryDistiller テスト

import { distillAndPromote } from "./memoryDistiller";
import { groqClient } from "../llm/groqClient";
import { createLearnedMemoryRepository } from "./learnedMemoryRepository";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn() },
}));

jest.mock("./learnedMemoryRepository", () => ({
  createLearnedMemoryRepository: jest.fn(),
}));

// GID 1216978660043409 (PR-17, R9): CV/outcome判定に使うDB層のモック。
const mockQuery = jest.fn();
jest.mock("../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));
jest.mock("../../api/admin/chat-history/chatHistoryRepository", () => ({
  getConversionTypes: jest.fn().mockResolvedValue(["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"]),
}));

const mockCall = groqClient.call as jest.Mock;
const mockCreateRepo = createLearnedMemoryRepository as jest.Mock;
const mockSave = jest.fn();

/** conversion_attributions に行がある想定でDBモックを設定する(=CVを伴う会話)。 */
function mockHasAttribution() {
  mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: true, outcome: null }] });
}

/** outcome が成約系(非成約終端2件でない)想定でDBモックを設定する。 */
function mockHasConvertingOutcome(outcome = "購入完了") {
  mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: false, outcome }] });
}

/** CV/outcomeどちらも無い想定でDBモックを設定する。 */
function mockNoConversion() {
  mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: false, outcome: null }] });
}

const ENV_KEYS = [
  "LEARNED_MEMORY_ENABLED",
  "LEARNED_MEMORY_TENANTS",
  "LEARNED_MEMORY_THRESHOLD",
] as const;

const MESSAGES = [
  { role: "user", content: "保証はありますか" },
  { role: "assistant", content: "全車3ヶ月保証付きです。延長保証もご用意しています。" },
];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = "test"; // embedText がダミーベクトルを返す
  mockCreateRepo.mockReturnValue({ saveLearnedMemory: mockSave });
  mockSave.mockResolvedValue(true);
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function enable(tenant = "carnation") {
  process.env.LEARNED_MEMORY_ENABLED = "true";
  process.env.LEARNED_MEMORY_TENANTS = tenant;
}

describe("distillAndPromote", () => {
  it("Feature Flag (write) オフなら蒸留せず false", async () => {
    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 95,
      messages: MESSAGES,
    });
    expect(ok).toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("スコアが閾値未満なら蒸留しない", async () => {
    enable();
    process.env.LEARNED_MEMORY_THRESHOLD = "80";
    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 70,
      messages: MESSAGES,
    });
    expect(ok).toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("高スコアなら蒸留→保存し true", async () => {
    enable();
    mockHasAttribution();
    mockCall.mockResolvedValue(
      '{"question":"保証はありますか","answer":"全車3ヶ月保証付きです"}',
    );

    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: MESSAGES,
    });

    expect(ok).toBe(true);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
    const saved = mockSave.mock.calls[0]![0];
    expect(saved.tenantId).toBe("carnation");
    expect(saved.question).toBe("保証はありますか");
    expect(saved.answer).toBe("全車3ヶ月保証付きです");
    expect(saved.judgeScore).toBe(90);
    expect(saved.embedding).toHaveLength(1536); // ダミー埋め込み
  });

  it("蒸留が空Q&Aを返したら保存しない", async () => {
    enable();
    mockHasAttribution();
    mockCall.mockResolvedValue('{"question":"","answer":""}');

    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: MESSAGES,
    });

    expect(ok).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("メッセージが2未満なら蒸留しない", async () => {
    enable();
    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ok).toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("Groq が例外でも伝播させず false", async () => {
    enable();
    mockHasAttribution();
    mockCall.mockRejectedValue(new Error("groq down"));

    await expect(
      distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      }),
    ).resolves.toBe(false);
  });

  // ---------------------------------------------------------------------
  // GID 1216978660043409 (PR-17, R9 / D2): 高スコアだが成果なしは昇格しない
  // ---------------------------------------------------------------------
  describe("D2: CV/outcomeを伴う会話のみ昇格する", () => {
    it("高スコアだがCV/outcomeが無い会話は蒸留せず false(Groqを呼ばない)", async () => {
      enable();
      mockNoConversion();

      const ok = await distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 95,
        messages: MESSAGES,
      });

      expect(ok).toBe(false);
      expect(mockCall).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("conversion_attributions に行があれば昇格する", async () => {
      enable();
      mockHasAttribution();
      mockCall.mockResolvedValue(
        '{"question":"保証はありますか","answer":"全車3ヶ月保証付きです"}',
      );

      const ok = await distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      });

      expect(ok).toBe(true);
    });

    it("outcomeが成約系(テナントのconversion_types非成約終端2件でない)なら昇格する", async () => {
      enable();
      mockHasConvertingOutcome("予約完了");
      mockCall.mockResolvedValue(
        '{"question":"保証はありますか","answer":"全車3ヶ月保証付きです"}',
      );

      const ok = await distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      });

      expect(ok).toBe(true);
    });

    it("outcomeが非成約終端(既定'離脱'/'不明')なら昇格しない", async () => {
      enable();
      mockHasConvertingOutcome("離脱");

      const ok = await distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      });

      expect(ok).toBe(false);
      expect(mockCall).not.toHaveBeenCalled();
    });
  });
});
