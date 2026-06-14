// Shared types for AIReportTab sub-components

export interface ScoreTrend {
  date: string;
  avg_score: number;
}

export interface PsychPrinciple {
  name: string;
  usage_count: number;
  effectiveness_rate: number;
}

export interface RuleEvidence {
  evaluationIds?: number[];
  effectivePrinciples?: string[];
  failedPrinciples?: string[];
  avgScore?: number;
}

export interface SuggestedRule {
  id: string;
  trigger: string;
  response: string;
  reason: string;
  evidence?: RuleEvidence | null;
}

export interface CustomerReaction {
  positive: number;
  neutral: number;
  negative: number;
  unknown?: number;
}

export interface KpiSummary {
  reply_rate: number;
  appointment_rate: number;
  lost_rate: number;
  reply_rate_delta: number;
  appointment_rate_delta: number;
  lost_rate_delta: number;
}

export interface OutcomeScore {
  outcome: string;
  avg_score: number;
  label: string;
}

export interface EvalStats {
  score_trend: ScoreTrend[];
  psychology_principles: PsychPrinciple[];
  customer_reactions: CustomerReaction;
  kpi_summary: KpiSummary;
  outcome_scores: OutcomeScore[];
}

export interface WeeklyReport {
  id: string;
  week_label: string;
  avg_score: number;
  avg_score_delta: number;
  appointment_rate: number;
  appointment_rate_delta: number;
  ab_summary: string | null;
}
