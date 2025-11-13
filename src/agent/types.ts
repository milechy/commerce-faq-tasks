// src/agent/types.ts

import type { Hit } from '../search/hybrid';
import type { Item as RerankItem, RerankResult } from '../search/rerank';

export type AgentStepType = 'plan' | 'tool' | 'synthesis';

export interface AgentStep {
  type: AgentStepType;
  message: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  elapsed_ms?: number;
}

export interface QueryPlan {
  /** 検索エンジンに投げる最終クエリ */
  searchQuery: string;
  /** rerank 後に何件まで見るか */
  topK: number;
  /** 将来用の filter / tenant / lang など */
  filters?: Record<string, unknown> | null;
}

export interface AgentDebug {
  query: {
    original: string;
    normalized: string;
    plan: QueryPlan;
  };
  search?: {
    items: Hit[];
    ms: number;
    note?: string;
  };
  rerank?: RerankResult;
}

export interface AgentSearchParams {
  q: string;
  topK?: number;
  debug?: boolean;
}

export interface AgentSearchResponse {
  answer: string;
  steps: AgentStep[];
  debug: AgentDebug;
}

// 既存 CE 型の re-export（必要に応じて使う）
export type { Hit, RerankItem, RerankResult };

export interface AgentSearchOptions {
  q: string
  topK?: number
  debug?: boolean

  /**
   * 将来 LLM プランナーを試験導入するときのフラグ。
   * - false/未指定: Rule-based Planner (同期)
   * - true: 非同期 Planner 経由 (将来的に LLM プランナーに差し替え)
   */
  useLlmPlanner?: boolean
}