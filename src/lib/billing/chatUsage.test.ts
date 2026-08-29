// src/lib/billing/chatUsage.test.ts
//
// buildChatUsageTracking は /api/chat・/dialog/turn・/agent.search が共有する
// 課金 usage 抽出ロジック。二重計上・別単価内包の不変条件をここで守る。

import { buildChatUsageTracking, CHAT_LLM_MODEL } from "./chatUsage";

describe("buildChatUsageTracking", () => {
  it("maps synthesis llmUsage to the chat model's input/output tokens", () => {
    const out = buildChatUsageTracking({
      llmUsage: { prompt_tokens: 130, completion_tokens: 45 },
    });
    expect(out.model).toBe(CHAT_LLM_MODEL);
    expect(out.inputTokens).toBe(130);
    expect(out.outputTokens).toBe(45);
    expect(out.extraLlmUsages).toBeUndefined();
  });

  it("records {0,0} chat tokens when meta is undefined (synthesis not run) — still a billable request", () => {
    const out = buildChatUsageTracking(undefined);
    expect(out.model).toBe(CHAT_LLM_MODEL);
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(out.extraLlmUsages).toBeUndefined();
  });

  it("folds the OpenAI query embedding into extraLlmUsages at its own model rate (never the chat model)", () => {
    const out = buildChatUsageTracking({
      llmUsage: { prompt_tokens: 100, completion_tokens: 20 },
      embeddingUsage: { model: "text-embedding-3-small", totalTokens: 512 },
    });
    // embedding must NOT be added into the chat model's input tokens (would be
    // billed at the far-higher chat rate — the exact PR-2 regression).
    expect(out.inputTokens).toBe(100);
    expect(out.extraLlmUsages).toEqual([
      { model: "text-embedding-3-small", inputTokens: 512, outputTokens: 0 },
    ]);
  });

  it("omits a zero-token embedding from extraLlmUsages", () => {
    const out = buildChatUsageTracking({
      llmUsage: { prompt_tokens: 10, completion_tokens: 3 },
      embeddingUsage: { model: "text-embedding-3-small", totalTokens: 0 },
    });
    expect(out.extraLlmUsages).toBeUndefined();
  });

  it("folds planner LLM usages (per model) into extraLlmUsages and drops empty ones", () => {
    const out = buildChatUsageTracking({
      llmUsage: { prompt_tokens: 200, completion_tokens: 60 },
      plannerLlmUsages: [
        { model: "openai/gpt-oss-20b", prompt_tokens: 80, completion_tokens: 12 },
        { model: "openai/gpt-oss-120b", prompt_tokens: 0, completion_tokens: 0 }, // dropped
      ],
      embeddingUsage: { model: "text-embedding-3-small", totalTokens: 256 },
    });
    expect(out.extraLlmUsages).toEqual([
      { model: "openai/gpt-oss-20b", inputTokens: 80, outputTokens: 12 },
      { model: "text-embedding-3-small", inputTokens: 256, outputTokens: 0 },
    ]);
  });
});
