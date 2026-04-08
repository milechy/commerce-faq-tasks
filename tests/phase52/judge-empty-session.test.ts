// tests/phase52/judge-empty-session.test.ts
// Phase52: Judge空セッション評価スキップのテスト

jest.mock("../../src/lib/gemini/client", () => ({
  callGeminiJudge: jest.fn(),
}));

jest.mock("../../src/lib/db", () => ({
  getPool: jest.fn(),
}));

jest.mock("fs/promises", () => ({
  readFile: jest.fn(),
}));

jest.mock("../../src/lib/knowledgeSearchUtil", () => ({
  searchKnowledgeForSuggestion: jest.fn().mockResolvedValue({ results: [] }),
  formatKnowledgeContext: jest.fn().mockReturnValue(""),
}));

jest.mock("../../src/lib/crossTenantContext", () => ({
  getCrossTenantContext: jest.fn().mockResolvedValue({
    avgScores: null, topPsychologyPrinciples: [], commonGapPatterns: [],
    effectiveRulePatterns: [], totalTenants: 0, dataAsOf: '',
  }),
  formatCrossTenantContext: jest.fn().mockReturnValue(""),
}));

import { callGeminiJudge } from "../../src/lib/gemini/client";
import { getPool } from "../../src/lib/db";
import { readFile } from "fs/promises";
import { evaluateSession } from "../../src/agent/judge/judgeEvaluator";

const mockCallGemini = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;
const mockGetPool = getPool as jest.MockedFunction<typeof getPool>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

const PROMPT_TEMPLATE = "Judge prompt\n{{CONVERSATION_LOG}}\nJSON only.";

function makeMockPool(queryImpl?: jest.Mock) {
  const query = queryImpl ?? jest.fn();
  return { query } as any;
}

function makeGeminiResponse(overallScore = 72): string {
  return JSON.stringify({
    overall_score: overallScore,
    psychology_fit_score: 70,
    customer_reaction_score: 72,
    stage_progress_score: 68,
    taboo_violation_score: 90,
    feedback: {
      psychology_fit: "良好",
      customer_reaction: "良好",
      stage_progress: "普通",
      taboo_violation: "違反なし",
      summary: "概ね良好な会話でした",
    },
    suggested_rules: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReadFile.mockResolvedValue(PROMPT_TEMPLATE as never);
});

describe("evaluateSession — 空/単一メッセージセッションのスキップ", () => {
  it("1. 0メッセージのセッション → null を返す（Gemini呼び出しなし）", async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "internal-uuid-empty", tenant_id: "tenant-a" }] })
      .mockResolvedValueOnce({ rows: [] }); // 0 messages

    const result = await evaluateSession("session-empty");

    expect(result).toBeNull();
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it("2. 1メッセージのセッション → null を返す（Gemini呼び出しなし）", async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "internal-uuid-single", tenant_id: "tenant-a" }] })
      .mockResolvedValueOnce({
        rows: [{ role: "user", content: "こんにちは", created_at: new Date() }],
      }); // 1 message only

    const result = await evaluateSession("session-single");

    expect(result).toBeNull();
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it("3. 2メッセージのセッション → 評価オブジェクトを返す（Gemini呼び出しあり）", async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "internal-uuid-two", tenant_id: "tenant-a" }] })
      .mockResolvedValueOnce({
        rows: [
          { role: "user", content: "商品の価格を教えて", created_at: new Date() },
          { role: "assistant", content: "こちらが価格表です。", created_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // INSERT evaluations

    mockCallGemini.mockResolvedValueOnce(makeGeminiResponse(72));

    const result = await evaluateSession("session-two");

    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(72);
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it("4. 3メッセージ以上のセッション → 評価オブジェクトを返す", async () => {
    const mockPool = makeMockPool();
    mockGetPool.mockReturnValue(mockPool);

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: "internal-uuid-three", tenant_id: "tenant-b" }] })
      .mockResolvedValueOnce({
        rows: [
          { role: "user", content: "予算は100万円です", created_at: new Date() },
          { role: "assistant", content: "承知しました。ご提案があります。", created_at: new Date() },
          { role: "user", content: "詳しく教えてください", created_at: new Date() },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // INSERT evaluations

    mockCallGemini.mockResolvedValueOnce(makeGeminiResponse(85));

    const result = await evaluateSession("session-three");

    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(85);
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });
});
