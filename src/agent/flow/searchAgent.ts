// src/agent/flow/searchAgent.ts

import { rerankTool } from '../tools/rerankTool';
import { searchTool } from '../tools/searchTool';
import { synthesizeAnswer } from '../tools/synthesisTool';
import type {
  AgentSearchParams,
  AgentSearchResponse,
  AgentStep,
} from '../types';
import { planQuery } from './queryPlanner';
import { planQueryWithLlmAsync } from './llmPlannerRuntime';

/**
 * /agent.search から呼ばれるメイン関数
 */
export async function runSearchAgent(
  params: AgentSearchParams,
): Promise<AgentSearchResponse> {
  const { q, topK, debug = true, useLlmPlanner } = params;
  const steps: AgentStep[] = [];

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
    type: 'plan',
    message: useLlmPlanner
      ? 'LLM Planner 経由で検索クエリを生成しました。'
      : 'Rule-based Planner で検索クエリを生成しました。',
    input: { q },
    output: plan,
    elapsed_ms: Math.round(tPlan1 - tPlan0),
  });

  // 2) Hybrid Search
  const tSearch0 = performance.now();
  const searchResult = await searchTool({ query: plan.searchQuery });
  const tSearch1 = performance.now();
  steps.push({
    type: 'tool',
    tool: 'search',
    message: 'ハイブリッド検索（ES + PG）を実行しました。',
    input: { query: plan.searchQuery },
    output: debug ? searchResult : { count: searchResult.items.length },
    elapsed_ms: Math.round(tSearch1 - tSearch0),
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
    type: 'tool',
    tool: 'rerank',
    message: 'Cross-Encoder で上位候補を再ランキングしました。',
    input: { topK: plan.topK },
    output: debug
      ? { items: rerankResult.items, ce_ms: rerankResult.ce_ms }
      : { count: rerankResult.items.length, ce_ms: rerankResult.ce_ms },
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
    type: 'synthesis',
    tool: 'synthesis',
    message: '再ランキングされたFAQから要約応答を生成しました。',
    input: { docCount: rerankResult.items.length },
    output: debug ? synth : undefined,
    elapsed_ms: Math.round(tSynth1 - tSynth0),
  });

  return {
    answer: synth.answer,
    steps,
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