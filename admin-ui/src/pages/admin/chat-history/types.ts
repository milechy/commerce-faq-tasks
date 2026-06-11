// ─── 型定義 ───────────────────────────────────────────────────────────────────

export interface SuggestedRule {
  rule_text: string;
  status?: string;
  tuning_rule_id?: number;
}

export interface Evaluation {
  id: number;
  overall_score?: number;
  score: number;
  psychology_fit_score?: number;
  customer_reaction_score?: number;
  stage_progress_score?: number;
  taboo_violation_score?: number;
  feedback?: { summary?: string };
  evaluated_at: string;
  suggested_rules?: SuggestedRule[];
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export type DeleteStep = "idle" | "step1" | "step2";
