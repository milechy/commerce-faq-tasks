// src/agent/flow/searchAgent.ts

import { searchPgVector } from "../../search/pgvectorSearch";
import { embedTextOpenAI } from "../llm/openaiEmbeddingClient";
import { rerankTool } from "../tools/rerankTool";
import { searchTool } from "../tools/searchTool";
import { synthesizeAnswer } from "../tools/synthesisTool";
import type {
  AgentSearchParams,
  AgentSearchResponse,
  AgentStep,
} from "../types";
import { planQueryWithLlmAsync } from "./llmPlannerRuntime";
import { planQuery } from "./queryPlanner";

/**
 * /agent.search から呼ばれるメイン関数
 */
export async function runSearchAgent(
  params: AgentSearchParams
): Promise<AgentSearchResponse> {
  const { q, topK, debug = true, useLlmPlanner, tenantId } = params;
  const effectiveTenantId = tenantId ?? "demo";
  const steps: AgentStep[] = [];

  const tTotal0 = performance.now();

  // 1) Query Planning
  const tPlan0 = performance.now();
  let plan;
  if (useLlmPlanner) {
    // LLM プランナーが有効なら LLM 経路を使用し、
    // 無効・エラー時は内部で Rule-based にフォールバックする。
    plan = await planQueryWithLlmAsync(q, { topK });
  } else {
    // 既存どおりの Rule-based Planner
    plan = planQuery(q, { topK });
  }
  const tPlan1 = performance.now();

  steps.push({
    type: "plan",
    message: useLlmPlanner
      ? "LLM Planner 経由で検索クエリを生成しました。"
      : "Rule-based Planner で検索クエリを生成しました。",
    input: { q },
    output: plan,
    elapsed_ms: Math.round(tPlan1 - tPlan0),
  });

  // 2) pgvector search (Phase7 A-mode: pgvector → ES)
  let pgVectorItems: any[] = [];
  let pgVectorMs = 0;
  let pgVectorError = false;
  try {
    const tPg0 = performance.now();
    const embedding = await embedTextOpenAI(plan.searchQuery ?? q);
    const pgRes = await searchPgVector({
      tenantId: effectiveTenantId,
      embedding,
      topK: plan.topK ?? topK,
    });
    const tPg1 = performance.now();
    pgVectorItems = pgRes.items ?? [];
    pgVectorMs = pgRes.ms ?? Math.round(tPg1 - tPg0);
  } catch (err) {
    pgVectorError = true;
    // pgvector が失敗しても致命的ではないため、ここでは握りつぶす
    console.error("[runSearchAgent] pgvector search failed", err);
  }

  // 3) Hybrid Search (ES)
  const tSearch0 = performance.now();
  const baseSearchResult = await searchTool({
    query: plan.searchQuery,
    tenantId: effectiveTenantId,
  });
  const tSearch1 = performance.now();

  // Aモード: pgvector → ES の順でマージ
  const mergedItems = [
    ...pgVectorItems.map((hit: any) => ({
      ...hit,
      source: (hit as any).source ?? "pgvector",
    })),
    ...(baseSearchResult.items || []),
  ];

  const searchResult = {
    ...baseSearchResult,
    items: mergedItems,
    ms: baseSearchResult.ms,
    note: [
      baseSearchResult.note,
      pgVectorError
        ? "pgvector:error"
        : pgVectorItems.length === 0
        ? "pgvector:no_hits"
        : "pgvector:used",
      pgVectorMs ? `pgvector_ms=${pgVectorMs}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  };

  steps.push({
    type: "tool",
    tool: "search",
    message: "ハイブリッド検索（ES + PG）を実行しました。",
    input: { query: plan.searchQuery, tenantId: effectiveTenantId },
    output: debug ? searchResult : { count: searchResult.items.length },
    elapsed_ms: Math.round(tSearch1 - tSearch0) + pgVectorMs,
  });

  // 3) Rerank (Cross-Encoder or dummy)
  const tRerank0 = performance.now();
  const rerankResult = await rerankTool({
    query: plan.searchQuery,
    items: searchResult.items,
    topK: plan.topK,
  });
  const tRerank1 = performance.now();
  steps.push({
    type: "tool",
    tool: "rerank",
    message: `上位候補を再ランキングしました (engine=${rerankResult.rerankEngine}).`,
    input: { topK: plan.topK },
    output: debug
      ? {
          items: rerankResult.items,
          ce_ms: rerankResult.ce_ms,
          engine: rerankResult.rerankEngine,
        }
      : {
          count: rerankResult.items.length,
          ce_ms: rerankResult.ce_ms,
          engine: rerankResult.rerankEngine,
        },
    elapsed_ms: Math.round(tRerank1 - tRerank0),
  });

  // 4) Answer Synthesis
  const tSynth0 = performance.now();
  const synth = synthesizeAnswer({
    query: q,
    items: rerankResult.items,
    maxChars: 450,
  });
  const tSynth1 = performance.now();
  steps.push({
    type: "synthesis",
    tool: "synthesis",
    message: "再ランキングされたFAQから要約応答を生成しました。",
    input: { docCount: rerankResult.items.length },
    output: debug ? synth : undefined,
    elapsed_ms: Math.round(tSynth1 - tSynth0),
  });

  const tTotal1 = performance.now();
  const ragStats = {
    plannerMs: Math.round(tPlan1 - tPlan0),
    searchMs: Math.round(tSearch1 - tSearch0) + pgVectorMs,
    rerankMs: Math.round(tRerank1 - tRerank0),
    answerMs: Math.round(tSynth1 - tSynth0),
    totalMs: Math.round(tTotal1 - tTotal0),
    rerankEngine: rerankResult.rerankEngine,
  };

  return {
    answer: synth.answer,
    steps,
    ragStats,
    debug: {
      query: {
        original: q,
        normalized: plan.searchQuery,
        plan,
      },
      search: debug
        ? {
            items: searchResult.items,
            ms: searchResult.ms,
            note: searchResult.note,
          }
        : undefined,
      rerank: debug ? rerankResult : undefined,
    },
  };
}
