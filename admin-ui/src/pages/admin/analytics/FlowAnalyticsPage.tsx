// admin-ui/src/pages/admin/analytics/FlowAnalyticsPage.tsx
// Phase72-C: State Machine フロー遷移分析 (Super Admin 専用)

import { useState, useEffect } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { authFetch, API_BASE } from "../../../lib/api";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

type AllowedPeriod = "7d" | "30d" | "90d";

interface TransitionRow {
  from_state: string | null;
  to_state: string;
  transition_count: number;
}

interface FlowTransitionsResponse {
  period: AllowedPeriod;
  tenant_id: string | null;
  total_transitions: number;
  funnel: {
    to_answer_count: number;
    to_confirm_count: number;
    to_terminal_count: number;
    completed_count: number;
    confirm_rate_pct: number;
    completion_rate_pct: number;
  };
  transitions: TransitionRow[];
}

const PERIOD_LABELS: Record<AllowedPeriod, string> = {
  "7d": "過去7日",
  "30d": "過去30日",
  "90d": "過去90日",
};

export default function FlowAnalyticsPage() {
  const [period, setPeriod] = useState<AllowedPeriod>("30d");
  const [data, setData] = useState<FlowTransitionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    authFetch(`${API_BASE}/v1/admin/analytics/flow-transitions?period=${period}`)
      .then((r) => {
        if (!r.ok) throw new Error(`取得失敗 (status ${r.status})`);
        return r.json() as Promise<FlowTransitionsResponse>;
      })
      .then(setData)
      .catch(() => setError("フロー遷移データの取得に失敗しました。しばらく待ってから再試行してください。"))
      .finally(() => setLoading(false));
  }, [period]);

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "var(--background)",
    color: "var(--foreground)",
    padding: "24px 20px",
    maxWidth: 960,
    margin: "0 auto",
  };

  const cardStyle: React.CSSProperties = {
    borderRadius: 14,
    border: "1px solid var(--border)",
    background: "var(--card)",
    padding: "20px 18px",
    marginBottom: 20,
    boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
  };

  const kpiCardStyle: React.CSSProperties = {
    flex: "1 1 140px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--card)",
    padding: "16px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  };

  const funnel = data?.funnel;

  // Bar chart data: funnel overview
  const barData = funnel
    ? {
        labels: ["answer遷移", "confirm遷移", "terminal遷移", "completed"],
        datasets: [
          {
            label: "遷移数",
            data: [
              funnel.to_answer_count,
              funnel.to_confirm_count,
              funnel.to_terminal_count,
              funnel.completed_count,
            ],
            backgroundColor: [
              "rgba(99,102,241,0.7)",
              "rgba(34,197,94,0.7)",
              "rgba(249,115,22,0.7)",
              "rgba(20,184,166,0.7)",
            ],
            borderRadius: 6,
          },
        ],
      }
    : null;

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
          フロー遷移分析
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 6 }}>
          State Machine の遷移ログから会話ファネルを可視化します
        </p>
      </div>

      {/* Period filter */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {(["7d", "30d", "90d"] as AllowedPeriod[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: period === p ? "var(--primary)" : "var(--card)",
              color: period === p ? "var(--primary-foreground)" : "var(--foreground)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: period === p ? 600 : 400,
              transition: "all 0.15s",
            }}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: "48px 0", color: "var(--muted-foreground)" }}>
          読み込み中...
        </div>
      )}

      {error && (
        <div
          style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 10,
            padding: "16px 18px",
            color: "var(--foreground)",
            marginBottom: 20,
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* KPI cards */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
            <div style={kpiCardStyle}>
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>総遷移数</span>
              <span style={{ fontSize: 26, fontWeight: 700 }}>{data.total_transitions.toLocaleString()}</span>
            </div>
            <div style={kpiCardStyle}>
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>confirm到達率</span>
              <span style={{ fontSize: 26, fontWeight: 700 }}>{funnel?.confirm_rate_pct ?? 0}%</span>
            </div>
            <div style={kpiCardStyle}>
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>完了率（terminal中）</span>
              <span style={{ fontSize: 26, fontWeight: 700 }}>{funnel?.completion_rate_pct ?? 0}%</span>
            </div>
            <div style={kpiCardStyle}>
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>completed数</span>
              <span style={{ fontSize: 26, fontWeight: 700 }}>{funnel?.completed_count ?? 0}</span>
            </div>
          </div>

          {/* Bar chart */}
          {barData && (
            <div style={cardStyle}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
                ファネル概要（{PERIOD_LABELS[period]}）
              </h3>
              <div style={{ height: 240 }}>
                <Bar
                  data={barData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      legend: { display: false },
                      title: { display: false },
                    },
                    scales: {
                      x: {
                        ticks: { color: "var(--muted-foreground)", font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                      },
                      y: {
                        ticks: { color: "var(--muted-foreground)", font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                        beginAtZero: true,
                      },
                    },
                  }}
                />
              </div>
            </div>
          )}

          {/* Transition table */}
          <div style={cardStyle}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 14px 0" }}>
              遷移詳細テーブル
            </h3>
            {data.transitions.length === 0 ? (
              <p style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
                この期間の遷移データがありません。
              </p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th style={{ textAlign: "left", padding: "8px 10px", color: "var(--muted-foreground)", fontWeight: 600 }}>遷移元</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", color: "var(--muted-foreground)", fontWeight: 600 }}>遷移先</th>
                    <th style={{ textAlign: "right", padding: "8px 10px", color: "var(--muted-foreground)", fontWeight: 600 }}>件数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.transitions.map((row, i) => (
                    <tr
                      key={i}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
                      }}
                    >
                      <td style={{ padding: "8px 10px" }}>
                        {row.from_state ?? <span style={{ color: "var(--muted-foreground)" }}>（開始）</span>}
                      </td>
                      <td style={{ padding: "8px 10px" }}>{row.to_state}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>
                        {row.transition_count.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
