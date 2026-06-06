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

const mockCall = groqClient.call as jest.Mock;
const mockCreateRepo = createLearnedMemoryRepository as jest.Mock;
const mockSave = jest.fn();

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
});
