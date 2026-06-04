// src/agent/crew/CrewAgent.ts

import type { DialogAgentMeta } from "../dialog/types";

export type CrewAgentInput = {
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  context?: { sessionId?: string; locale?: string; tenantId?: string; mode?: string; useMultiStepPlanner?: boolean; excludedIds?: string[] };
};

export type CrewAgentOutput = {
  text: string;
  reasoning?: string;
  meta?: DialogAgentMeta;
};

// NOTE: CrewAgent クラス本体は CrewGraph (LangGraph 統一) に置換済みのため削除。
// CrewAgentInput / CrewAgentOutput 型は CrewOrchestrator 等が参照するため保持する。
