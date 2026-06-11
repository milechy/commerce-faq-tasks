import type { NavigateFunction } from "react-router-dom";
import type { AnalyticsEvaluationsResponse } from "./types";
import { scoreColor, chartCardStyle } from "./utils";

interface LowScoreSessionsTableProps {
  evaluations: AnalyticsEvaluationsResponse;
  navigate: NavigateFunction;
}

export function LowScoreSessionsTable({ evaluations, navigate }: LowScoreSessionsTableProps) {
  return (
    <div style={chartCardStyle}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
        AI応答品質が低い会話
      </h3>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["セッションID", "スコア", "評価日時", "メッセージ数", "フィードバック"].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "8px 12px",
                    textAlign: "left",
                    color: "var(--muted-foreground)",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evaluations.low_score_sessions.map((s) => (
              <tr
                key={s.session_id}
                style={{ borderBottom: "1px solid rgba(31,41,55,0.5)" }}
              >
                <td style={{ padding: "10px 12px" }}>
                  <button
                    onClick={() => navigate(`/admin/chat-history/${s.session_id}`)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#60a5fa",
                      fontSize: 13,
                      cursor: "pointer",
                      padding: 0,
                      fontFamily: "monospace",
                      textDecoration: "underline",
                    }}
                  >
                    {s.session_id.slice(0, 12)}…
                  </button>
                </td>
                <td style={{ padding: "10px 12px" }}>
                  <span style={{ color: scoreColor(s.score), fontWeight: 700 }}>
                    {s.score}
                  </span>
                </td>
                <td style={{ padding: "10px 12px", color: "var(--muted-foreground)", whiteSpace: "nowrap" }}>
                  {new Date(s.evaluated_at).toLocaleDateString("ja-JP", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td style={{ padding: "10px 12px", color: "var(--muted-foreground)", textAlign: "center" }}>
                  {s.message_count}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    color: "var(--muted-foreground)",
                    maxWidth: 240,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.feedback_summary}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
