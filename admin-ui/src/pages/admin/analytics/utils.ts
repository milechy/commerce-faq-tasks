import type { CSSProperties } from "react";

export const PERIOD_LABELS: Record<string, string> = {
  "7d": "7日",
  "30d": "30日",
  "90d": "90日",
};

export const scoreColor = (score: number | null) => {
  if (score === null) return "#9ca3af";
  if (score >= 80) return "#4ade80";
  if (score >= 60) return "#fbbf24";
  return "#f87171";
};

export const sentimentColors = {
  positive: "rgba(99, 153, 34, 0.8)",
  neutral: "rgba(136, 135, 128, 0.5)",
  negative: "rgba(226, 75, 74, 0.8)",
};

export const sentimentKpiColor = (positiveRate: number) => {
  if (positiveRate >= 0.7) return "#4ade80";
  if (positiveRate >= 0.5) return "#fbbf24";
  return "#f87171";
};

// ─── スタイル定数 ─────────────────────────────────────────
export const cardStyle: CSSProperties = {
  flex: "1 1 160px",
  borderRadius: 14,
  border: "1px solid var(--border)",
  background: "linear-gradient(145deg, var(--card), var(--card))",
  padding: "20px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
};

export const chartCardStyle: CSSProperties = {
  borderRadius: 14,
  border: "1px solid var(--border)",
  background: "linear-gradient(145deg, var(--card), var(--card))",
  padding: "20px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
  marginBottom: 20,
};
