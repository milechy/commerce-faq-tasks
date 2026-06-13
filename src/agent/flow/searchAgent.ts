// src/agent/flow/searchAgent.ts


import { searchPgVector, type PgvectorSearchItem } from "../../search/pgvectorSearch";
import { embedTextWithUsage } from "../llm/openaiEmbeddingClient";
import { createLearnedMemoryRepository, type LearnedMemoryHit } from "../memory/learnedMemoryRepository";
import { isLearnedMemoryReadEnabled, getLearnedMemoryWeight } from "../memory/featureFlag";
import { rerankTool } from "../tools/rerankTool";
import { searchTool } from "../tools/searchTool";
import { synthesizeAnswer } from "../tools/synthesisTool";
import type {
  AgentSearchParams,
  AgentSearchResponse,
  AgentStep,
  RagSource,
} from "../types";
import { planQueryWithLlmAsync } from "./llmPlannerRuntime";
import { planQuery } from "./queryPlanner";
import { getBehaviorContext } from "../../api/events/behaviorContext";
import { findSimilarPatterns } from "../../api/events/similarUserMatcher";
import { pool } from "../../lib/db";
import { logger } from '../../lib/logger';

/**
 * /agent.search から呼ばれるメイン関数
 */
export async function runSearchAgent(
  params: AgentSearchParams
): Promise<AgentSearchResponse> {
  const { q, topK, debug = true, useLlmPlanner, tenantId, visitorId, excludedIds } = params;
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
  //    Phase71-A: 同じ埋め込みを使い learned_memory も並列取得する。
  let pgVectorItems: PgvectorSearchItem[] = [];
  let pgVectorMs = 0;
  let pgVectorError = false;
  let learnedItems: LearnedMemoryHit[] = [];
  let embeddingTokens = 0;
  try {
    const tPg0 = performance.now();
    const { embedding, totalTokens: _et } = await embedTextWithUsage(plan.searchQuery ?? q);
    embeddingTokens = _et;
    const learnedReadEnabled = isLearnedMemoryReadEnabled(effectiveTenantId);
    const [pgRes, learnedRes] = await Promise.all([
      searchPgVector({
        tenantId: effectiveTenantId,
        embedding,
        topK: plan.topK ?? topK,
        excludedIds,
      }),
      learnedReadEnabled
        ? createLearnedMemoryRepository()
            .searchLearnedMemory({
              tenantId: effectiveTenantId,
              embedding,
              topK: plan.topK ?? topK,
              weight: getLearnedMemoryWeight(),
            })
            .catch((err) => {
              // 学習メモリ検索の失敗は致命的でないため握りつぶす
              logger.error("[runSearchAgent] learned_memory search failed", err);
              return [] as LearnedMemoryHit[];
            })
        : Promise.resolve([] as LearnedMemoryHit[]),
    ]);
    const tPg1 = performance.now();
    pgVectorItems = pgRes.items ?? [];
    learnedItems = learnedRes ?? [];
    pgVectorMs = pgRes.ms ?? Math.round(tPg1 - tPg0);
  } catch (err) {
    pgVectorError = true;
    // pgvector が失敗しても致命的ではないため、ここでは握りつぶす
    logger.error("[runSearchAgent] pgvector search failed", err);
  }

  // 3) Hybrid Search (ES)
  const tSearch0 = performance.now();
  const baseSearchResult = await searchTool({
    query: plan.searchQuery,
    tenantId: effectiveTenantId,
    excludedIds,
  });
  const tSearch1 = performance.now();

  // Aモード: pgvector → learned_memory → ES の順でマージ
  // learned_memory は pgvector 経路で取得するため Hit.source は "pg" に揃え、
  // 学習データである provenance は metadata.source="learned" に保持する。
  const mergedItems = [
    ...pgVectorItems.map((hit) => ({
      ...hit,
      source: "pg" as const,
    })),
    ...learnedItems.map((hit) => ({
      id: hit.id,
      text: hit.text,
      score: hit.score,
      source: "pg" as const,
      metadata: hit.metadata,
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
    excludedIds,
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

  // Phase57: 行動コンテキスト + 類似パターンを非同期で取得（エラー時はnull）
  const [behaviorContext, similarPatterns] = await Promise.all([
    visitorId ? getBehaviorContext(effectiveTenantId, visitorId) : Promise.resolve(null),
    visitorId && pool
      ? getBehaviorContext(effectiveTenantId, visitorId).then((ctx) =>
          ctx ? findSimilarPatterns(pool!, effectiveTenantId, ctx) : [],
        ).catch(() => [])
      : Promise.resolve([]),
  ]).catch(() => [null, []] as [null, []]);

  // 4) Answer Synthesis
  const tSynth0 = performance.now();
  const synth = await synthesizeAnswer({
    query: q,
    items: rerankResult.items,
    maxChars: 450,
    tenantId: effectiveTenantId,
    behaviorContext,
    similarPatterns: similarPatterns ?? [],
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

  // Phase68: rerank 後の topK チャンクを RAG ソースとして抽出。
  // metadata の 'source' が 'book' のときのみ principle/book 扱い、
  // 未設定 (ES ヒット or 旧データ) は FAQ として扱う。
  const ragSources: RagSource[] = rerankResult.items.map((it) => {
    const meta = (it as { metadata?: Record<string, unknown> }).metadata;
    const sourceType = meta && meta["source"] === "book" ? "book" : "faq";
    const principle = typeof meta?.["principle"] === "string"
      ? (meta["principle"] as string)
      : undefined;
    const source: RagSource = {
      chunk_id: String(it.id),
      source: sourceType,
      score: typeof it.score === "number" ? it.score : 0,
    };
    if (principle) source.principle = principle;
    return source;
  });

  return {
    answer: synth.answer,
    steps,
    ragStats,
    ragSources,
    gapSignal: synth.gapSignal,
    // Subtask 3: synthesis が usage を返さない場合（GROQ キー無し / fallback / エラー）でも
    // 既に消費済みの embedding トークンを課金に残すため、llmUsage は常に返す。
    // chat LLM が完全に未実行なら {0,0} となり、上位で「chat 実トークン 0」を表す。
    llmUsage: {
      prompt_tokens:     (synth.llmUsage?.prompt_tokens ?? 0) + embeddingTokens,
      completion_tokens: synth.llmUsage?.completion_tokens ?? 0,
    },
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
