// src/agent/types.ts

import type { Hit } from "../search/hybrid";
import type { Item as RerankItem, RerankResult } from "../search/rerank";

export type AgentStepType = "plan" | "tool" | "synthesis";

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
  useLlmPlanner?: boolean;
  tenantId?: string;
}

export interface AgentSearchResponse {
  answer: string;
  steps: AgentStep[];
  ragStats?: {
    plannerMs?: number;
    searchMs?: number;
    rerankMs?: number;
    answerMs?: number;
    totalMs?: number;
    rerankEngine?: string;
  };
  debug: AgentDebug;
}

// 既存 CE 型の re-export（必要に応じて使う）
export type { Hit, RerankItem, RerankResult };

export interface AgentSearchOptions {
  q: string;
  topK?: number;
  debug?: boolean;

  /**
   * 将来 LLM プランナーを試験導入するときのフラグ。
   * - false/未指定: Rule-based Planner (同期)
   * - true: 非同期 Planner 経由 (将来的に LLM プランナーに差し替え)
   */
  useLlmPlanner?: boolean;
}

// src/agent/dialog/types.ts

export type PlannerRoute = "20b" | "120b";

export interface DialogTurnInput {
  message: string;
  sessionId?: string;
  options?: {
    language?: "ja" | "en";
    useMultiStepPlanner?: boolean;
    piiMode?: boolean;
    personaTags?: string[];
  };
}

export type DialogOrchestratorMode = "langgraph";

export type DialogAgentStep = {
  id: string;
  title: string;
  description?: string;
  stage?: "clarify" | "propose" | "recommend" | "close";
  question?: string;
  cta?: "purchase" | "reserve" | "contact" | "download" | "other";
};

export type DialogAgentResponse = {
  sessionId?: string;
  answer: string | null;
  steps: DialogAgentStep[];
  meta: DialogAgentMeta;
};

export interface DialogAgentMeta {
  route: PlannerRoute;
  plannerReasons: string[];
  orchestratorMode: DialogOrchestratorMode;
  safetyTag?: string;
  requiresSafeMode?: boolean;

  /**
   * Phase22 (PR2b): Presentation/adapter state for external avatar connection.
   * - UI MUST NOT display "connected" unless status === "ready".
   * - This field is presentation-only and MUST NOT affect dialog correctness.
   */
  adapter?: {
    provider: "lemon_slice";
    status: "disabled" | "skipped_pii" | "fallback" | "failed" | "ready";
    reason?: string;
    readinessMs?: number;
  };
}
