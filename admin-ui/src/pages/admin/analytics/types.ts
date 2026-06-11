import type { ChartData } from "chart.js";

// === API Response Types ===
export interface AnalyticsSummaryResponse {
  period: string;
  tenant_id: string | null;
  total_sessions: number;
  avg_judge_score: number | null;
  total_knowledge_gaps: number;
  avg_messages_per_session: number;
  avatar_session_count: number;
  avatar_rate: number;
  prev_total_sessions: number;
  sessions_change_pct: number;
  sentiment_distribution: {
    positive: number;
    negative: number;
    neutral: number;
    total: number;
  };
  // Phase65-3: CV metrics
  cv_count_30d: number;
  cv_total_value_30d: number;
  cv_types_breakdown: {
    purchase: number;
    inquiry: number;
    reservation: number;
    signup: number;
    other: number;
  };
  cv_fired_status: "fired" | "not_fired";
  cv_days_since_first_session: number | null;
}

export interface AnalyticsTrendsResponse {
  period: string;
  tenant_id: string | null;
  daily: Array<{
    date: string;
    sessions: number;
    avg_score: number | null;
    knowledge_gaps: number;
    sentiment_positive: number;
    sentiment_negative: number;
    sentiment_neutral: number;
  }>;
}

export interface AnalyticsEvaluationsResponse {
  period: string;
  tenant_id: string | null;
  score_distribution: Array<{
    range: string;
    count: number;
  }>;
  axis_averages: {
    psychology_fit: number;
    customer_reaction: number;
    stage_progress: number;
    taboo_violation: number;
  };
  low_score_sessions: Array<{
    session_id: string;
    score: number;
    evaluated_at: string;
    message_count: number;
    feedback_summary: string;
  }>;
}


// Phase52f: コンバージョン分析
export interface ConversionResponse {
  summary: {
    total_sessions: number;
    recorded_outcomes: number;
    recording_rate: number;
    outcomes: Record<string, number>;
  };
  conversion_rate_trend: Array<{
    date: string;
    total: number;
    converted: number;
    rate: number;
  }>;
  technique_effectiveness: Array<{
    technique: string;
    sessions_used: number;
    converted: number;
    conversion_rate: number;
  }>;
  stage_dropout: Record<string, number>;
}

export interface Tenant {
  id: string;
  name: string;
}

// ─── Chart データ型（react-chartjs-2 props 用） ──────────────
export type LineChartData = ChartData<"line", number[], string>;
export type BarChartData = ChartData<"bar", number[], string>;
export type DoughnutChartData = ChartData<"doughnut", number[], string>;
export type RadarChartData = ChartData<"radar", number[], string>;
export type PieChartData = ChartData<"pie", number[], string>;
