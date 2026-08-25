// src/agent/tools/synthesisTool.groundless.test.ts
//
// ナレッジ配線是正 P1 (Asana GID 1217811043772726):
// 検索ヒット0件だが tuning_rules が1件以上一致するとき、faqContext='' のまま
// LLM が呼ばれ、応答ルール(expected_behavior は「方針」であって「事実」ではない)
// だけを根拠に事実の主張を生成しうる欠陥を塞いだことを固定する。
//
// CLAUDE.md 禁止46(知識を通さない回答経路を作らない)の実質的な抜け穴だった。
// 3層モデル(FAQ=事実 / expected_behavior=方針 / approved_responses=文体)は
// .claude/rules/knowledge.md 参照。

import { synthesizeAnswer } from "./synthesisTool";
import { groqClient } from "../llm/groqClient";
import { getPool } from "../../lib/db";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn(), callWithUsage: jest.fn() },
}));

jest.mock("../../lib/db", () => ({ getPool: jest.fn() }));

const MATCHING_RULE_ROW = {
  id: 42,
  tenant_id: "tenant-1",
  trigger_pattern: "保証,返品",
  expected_behavior: "保証期間は必ず3年と案内し、値引き交渉には応じないこと。",
  priority: 1,
  is_active: true,
  created_by: "test",
  source_message_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  approved_responses: [],
};

const FAQ_ITEM = { id: "faq-1", text: "保証は3ヶ月です", score: 0.9, source: "es" as const };

/** SQL文の特徴的な部分文字列で振り分ける pool.query モック。 */
function mockPoolWithMatchingRule() {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("FROM tuning_rules")) {
      return Promise.resolve({ rows: [MATCHING_RULE_ROW] });
    }
    if (sql.includes("FROM tenants")) {
      return Promise.resolve({
        rows: [{ system_prompt: null, system_prompt_variants: [], recorded_variant_id: null }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  (getPool as jest.Mock).mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env["GAP_DETECTION_ENABLED"] = "false";
});

afterEach(() => {
  delete process.env["GROQ_API_KEY"];
  delete process.env["GAP_DETECTION_ENABLED"];
});

describe("synthesizeAnswer — 検索0件+ルール一致時の接地", () => {
  it("systemPrompt に接地なしブロックが含まれ、事実主張の禁止が明示される", async () => {
    mockPoolWithMatchingRule();
    process.env["GROQ_API_KEY"] = "test-groq-key";
    (groqClient.callWithUsage as jest.Mock).mockResolvedValue({
      content: "恐れ入りますが、こちらでは正確にお答えできる情報がございません。",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await synthesizeAnswer({
      query: "保証について教えてください",
      items: [],
      tenantId: "tenant-1",
    });

    const call = (groqClient.callWithUsage as jest.Mock).mock.calls[0]![0];
    const systemMessage = call.messages.find((m: { role: string }) => m.role === "system").content;
    expect(systemMessage).toContain("参照可能な知識がありません");
    expect(systemMessage).toContain("推測や一般論で答えてはいけません");
  });

  it("userPrompt に参考FAQブロックが含まれない(faqContextが空のまま)", async () => {
    mockPoolWithMatchingRule();
    process.env["GROQ_API_KEY"] = "test-groq-key";
    (groqClient.callWithUsage as jest.Mock).mockResolvedValue({
      content: "回答",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await synthesizeAnswer({
      query: "保証について教えてください",
      items: [],
      tenantId: "tenant-1",
    });

    const call = (groqClient.callWithUsage as jest.Mock).mock.calls[0]![0];
    const userMessage = call.messages.find((m: { role: string }) => m.role === "user").content;
    expect(userMessage).not.toContain("参考FAQ:");
  });

  it("GROQ_API_KEY未設定+0ヒット+ルール一致: expected_behaviorを逐語で返さず定型メッセージにする", async () => {
    mockPoolWithMatchingRule();
    delete process.env["GROQ_API_KEY"];

    const result = await synthesizeAnswer({
      query: "保証について教えてください",
      items: [],
      tenantId: "tenant-1",
    });

    expect(result.answer).not.toContain(MATCHING_RULE_ROW.expected_behavior);
    expect(result.answer).toContain("見つかりませんでした");
    expect(result.appliedRuleIds).toEqual([MATCHING_RULE_ROW.id]);
  });

  it("LLM呼び出し失敗時も expected_behavior を逐語で返さない", async () => {
    mockPoolWithMatchingRule();
    process.env["GROQ_API_KEY"] = "test-groq-key";
    (groqClient.callWithUsage as jest.Mock).mockRejectedValue(new Error("groq down"));

    const result = await synthesizeAnswer({
      query: "保証について教えてください",
      items: [],
      tenantId: "tenant-1",
    });

    expect(result.answer).not.toContain(MATCHING_RULE_ROW.expected_behavior);
    expect(result.answer).toContain("見つかりませんでした");
  });

  it("回帰: 1件以上ヒットのときは接地なしブロックを注入せず、参考FAQブロックが従来どおり入る", async () => {
    mockPoolWithMatchingRule();
    process.env["GROQ_API_KEY"] = "test-groq-key";
    (groqClient.callWithUsage as jest.Mock).mockResolvedValue({
      content: "3ヶ月保証です。",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await synthesizeAnswer({
      query: "保証について教えてください",
      items: [FAQ_ITEM],
      tenantId: "tenant-1",
    });

    const call = (groqClient.callWithUsage as jest.Mock).mock.calls[0]![0];
    const systemMessage = call.messages.find((m: { role: string }) => m.role === "system").content;
    const userMessage = call.messages.find((m: { role: string }) => m.role === "user").content;
    expect(systemMessage).not.toContain("参照可能な知識がありません");
    expect(userMessage).toContain("参考FAQ:");
  });

  it("回帰: ヒット0件・ルールも0件のときは従来どおり定型メッセージを返す", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getPool as jest.Mock).mockReturnValue({ query });

    const result = await synthesizeAnswer({
      query: "全く関係ない質問",
      items: [],
      tenantId: "tenant-1",
    });

    expect(result.answer).toContain("見つかりませんでした");
    expect(groqClient.callWithUsage as jest.Mock).not.toHaveBeenCalled();
  });
});
