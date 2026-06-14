import { useState } from "react";
import { CARD, SECTION_TITLE } from "./styles";
import type { WeeklyReport } from "./types";

const MOCK_WEEKLY: WeeklyReport[] = [
  {
    id: "wr1",
    week_label: "3/20 - 3/26",
    avg_score: 72,
    avg_score_delta: 5,
    appointment_rate: 13.3,
    appointment_rate_delta: 1.2,
    ab_summary: "variant_bが8点高い",
  },
  {
    id: "wr2",
    week_label: "3/13 - 3/19",
    avg_score: 67,
    avg_score_delta: -2,
    appointment_rate: 12.1,
    appointment_rate_delta: -0.4,
    ab_summary: null,
  },
];

export function WeeklyReportSection({
  isSuperAdmin,
}: {
  isSuperAdmin: boolean;
}) {
  const reports = MOCK_WEEKLY;
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div style={CARD}>
      <p style={SECTION_TITLE}>📊 週次レポート</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {reports.map((r) => (
          <div
            key={r.id}
            style={{
              borderRadius: 10,
              border: "1px solid #1f2937",
              background: "rgba(0,0,0,0.2)",
              padding: "14px 16px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: expanded === r.id ? 14 : 0 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#f9fafb" }}>
                {r.week_label} のレポート
              </span>
              <button
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                style={{
                  padding: "6px 14px",
                  minHeight: 36,
                  borderRadius: 8,
                  border: "1px solid #374151",
                  background: "transparent",
                  color: "#9ca3af",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {expanded === r.id ? "閉じる" : "詳細を見る"}
              </button>
            </div>

            {expanded === r.id && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 14, color: "#d1d5db" }}>
                  AIスコア:{" "}
                  <span style={{ fontWeight: 700, color: "#f9fafb" }}>平均 {r.avg_score}点</span>
                  {" "}
                  <span style={{ color: r.avg_score_delta >= 0 ? "#4ade80" : "#f87171", fontWeight: 600 }}>
                    （先週比 {r.avg_score_delta >= 0 ? "+" : ""}{r.avg_score_delta}点）
                  </span>
                </div>
                <div style={{ fontSize: 14, color: "#d1d5db" }}>
                  アポ率:{" "}
                  <span style={{ fontWeight: 700, color: "#f9fafb" }}>{r.appointment_rate}%</span>
                  {" "}
                  <span style={{ color: r.appointment_rate_delta >= 0 ? "#4ade80" : "#f87171", fontWeight: 600 }}>
                    （先週比 {r.appointment_rate_delta >= 0 ? "+" : ""}{r.appointment_rate_delta}%）
                  </span>
                </div>
                {isSuperAdmin && r.ab_summary && (
                  <div style={{ fontSize: 14, color: "#d1d5db" }}>
                    A/Bテスト:{" "}
                    <span style={{ fontWeight: 600, color: "#c4b5fd" }}>{r.ab_summary}</span>
                  </div>
                )}
              </div>
            )}

            {expanded !== r.id && (
              <div style={{ fontSize: 13, color: "#6b7280" }}>
                AIスコア {r.avg_score}点 / アポ率 {r.appointment_rate}%
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
