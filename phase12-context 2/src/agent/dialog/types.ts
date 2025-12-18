// src/agent/dialog/types.ts

import type { OrchestratorStep } from "../flow/dialogOrchestrator";
import type { PlannerRoute } from "../orchestrator/modelRouter";
import type { SalesMeta } from "../orchestrator/sales/salesPipeline";
import type { AgentStep } from "../types";

export type PlanStepType = "clarify" | "search" | "followup_search" | "answer";

export interface BasePlanStep {
  id: string;
  type: PlanStepType;
  description?: string;
}

export interface ClarifyStep extends BasePlanStep {
  type: "clarify";
  questions: string[];
}

export interface SearchStep extends BasePlanStep {
  type: "search";
  query: string;
  topK: number;
  filters?: Record<string, unknown> | null;
}

export interface FollowupSearchStep extends BasePlanStep {
  type: "followup_search";
  basedOn: "user" | "previous_answer";
  query: string;
  topK: number;
}

export interface AnswerStep extends BasePlanStep {
  type: "answer";
  style: "faq" | "step_by_step";
  includeSources: boolean;
}

export type PlanStep =
  | ClarifyStep
  | SearchStep
  | FollowupSearchStep
  | AnswerStep;

export interface MultiStepQueryPlan {
  steps: PlanStep[];
  needsClarification: boolean;
  clarifyingQuestions?: string[];
  followupQueries?: string[];
  confidence: "low" | "medium" | "high";
  language?: "ja" | "en" | "other";
  raw?: unknown;
}

export type DialogMessageRole = "user" | "assistant" | "system";

export interface DialogMessage {
  role: DialogMessageRole;
  content: string;
}

export interface DialogTurnInput {
  sessionId?: string;
  message: string;
  history?: DialogMessage[];
  options?: {
    topK?: number;
    language?: "ja" | "en" | "auto";
    useLlmPlanner?: boolean;
    useMultiStepPlanner?: boolean;
    mode?: "local" | "crew";
    debug?: boolean;
  };
}

export interface DialogTurnMeta {
  multiStepPlan?: MultiStepQueryPlan;
  orchestratorMode: "local" | "crew";
  latencyMs?: number;
  needsClarification?: boolean;
  clarifyingQuestions?: string[];
  orchestrationSteps?: OrchestratorStep[];
}

export interface DialogTurnResult {
  sessionId: string;
  answer: string | null;
  needsClarification: boolean;
  clarifyingQuestions?: string[];
  plannerPlan?: PlannerPlan | null;
  salesMeta?: Record<string, unknown> | null;
  steps: (AgentStep | OrchestratorStep)[];
  final: boolean;
  meta?: DialogTurnMeta;
}

// --- Phase8: Sales-oriented Planner types ---

export type SalesStage = "clarify" | "propose" | "recommend" | "close";

export type PlannerStep = {
  id: string;
  stage: SalesStage;
  title: string;
  description: string;
  question?: string;
  productIds?: string[];
  cta?: "purchase" | "reserve" | "contact" | "download" | "other";
};

export interface PlannerPlan extends Omit<MultiStepQueryPlan, "steps"> {
  steps: PlannerStep[];
}

export type KpiFunnelStage = "awareness" | "consideration" | "conversion";

export interface KpiFunnelMeta {
  currentStage?: KpiFunnelStage;
  reachedStages?: KpiFunnelStage[];
  stepsCountByStage?: Record<KpiFunnelStage, number>;
}

export type DialogOrchestratorMode =
  | "langgraph"
  | "crewgraph"
  | "local"
  | "fallback-local-429";

export interface DialogAgentMeta {
  route: PlannerRoute;
  plannerReasons: string[];
  orchestratorMode: DialogOrchestratorMode;
  safetyTag?: string;
  requiresSafeMode?: boolean;
  ragStats?: {
    searchMs?: number;
    rerankMs?: number;
    rerankEngine?: "heuristic" | "ce" | "ce+fallback";
    totalMs?: number;
  };
  salesMeta?: SalesMeta;
  plannerPlan?: PlannerPlan;
  graphVersion: string;
  kpiFunnel?: KpiFunnelMeta;
  multiStepPlan?: unknown;
  sessionId?: string;
}

export interface DialogAgentResponse {
  sessionId?: string;
  answer: string | null;
  steps: PlannerStep[];
  final: boolean;
  needsClarification: boolean;
  clarifyingQuestions: string[];
  meta: DialogAgentMeta;
}
