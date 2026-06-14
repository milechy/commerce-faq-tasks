/**
 * Phase72-D: メトリクス時系列グラフ（super_admin 専用）
 *
 * - 3タブ: 会話 / アバター / RAG
 * - period + granularity フィルタ
 * - authFetch で /v1/admin/analytics/metrics-history を呼ぶ
 */

import { useState, useEffect } from "react";
import { Line, Bar } from "react-chartjs-2";
import { authFetch, API_BASE } from "../../../lib/api";
import { chartCardStyle } from "./utils";

interface MetricsTimeseriesSectionProps {
  isSuperAdmin: boolean;
}

interface SeriesPoint {
  timestamp: string;
  value: number;
  labels: Record<string, string | number>;
}

interface MetricsHistoryResponse {
  metric: string;
  period: string;
  granularity: string;
  series: SeriesPoint[];
}

const TABS = [
  { id: "conversation", label: "会話" },
  { id: "avatar", label: "アバター" },
  { id: "rag", label: "RAG" },
] as const;

type TabId = typeof TABS[number]["id"];

const TAB_METRICS: Record<TabId, string> = {
  conversation: "rajiuce_conversation_terminal_total",
  avatar: "rajiuce_avatar_requests_total",
  rag: "rajiuce_rag_duration_ms",
};

const TAB_COLORS: Record<TabId, string> = {
  conversation: "#60a5fa",
  avatar: "#a78bfa",
  rag: "#34d399",
};

const PERIOD_OPTIONS = [
  { value: "1d", label: "1日" },
  { value: "7d", label: "7日" },
  { value: "30d", label: "30日" },
];

const GRANULARITY_OPTIONS = [
  { value: "1h", label: "1時間" },
  { value: "6h", label: "6時間" },
  { value: "24h", label: "24時間" },
];

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MetricsTimeseriesSection({ isSuperAdmin }: MetricsTimeseriesSectionProps) {
  if (!isSuperAdmin) return null;

  const [activeTab, setActiveTab] = useState<TabId>("conversation");
  const [period, setPeriod] = useState("7d");
  const [granularity, setGranularity] = useState("1h");
  const [data, setData] = useState<MetricsHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const metric = TAB_METRICS[activeTab];
    const params = new URLSearchParams({ metric, period, granularity });

    setLoading(true);
    setError(null);

    authFetch(`${API_BASE}/v1/admin/analytics/metrics-history?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<MetricsHistoryResponse>;
      })
      .then((json) => setData(json))
      .catch(() => setError("メトリクスデータの読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }, [activeTab, period, granularity]);

  const series = data?.series ?? [];

  const chartData = {
    labels: series.map((p) => formatTimestamp(p.timestamp)),
    datasets: [
      {
        label: TABS.find((t) => t.id === activeTab)?.label ?? "",
        data: series.map((p) => p.value),
        borderColor: TAB_COLORS[activeTab],
        backgroundColor: `${TAB_COLORS[activeTab]}14`,
        borderWidth: 2,
        pointRadius: series.length > 50 ? 0 : 3,
        tension: 0.3,
        fill: true,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: "var(--muted-foreground)", maxTicksLimit: 8, font: { size: 11 } },
        grid: { color: "rgba(255,255,255,0.05)" },
      },
      y: {
        ticks: { color: "var(--muted-foreground)", font: { size: 11 } },
        grid: { color: "rgba(255,255,255,0.05)" },
        beginAtZero: true,
      },
    },
  } as const;

  const isBarChart = activeTab === "rag";

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)", margin: 0 }}>
          メトリクス時系列
        </h2>
        {/* Filters */}
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{ fontSize: 13, padding: "4px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)" }}
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            value={granularity}
            onChange={(e) => setGranularity(e.target.value)}
            style={{ fontSize: 13, padding: "4px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)" }}
          >
            {GRANULARITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: activeTab === tab.id ? `1px solid ${TAB_COLORS[tab.id]}` : "1px solid var(--border)",
              background: activeTab === tab.id ? `${TAB_COLORS[tab.id]}20` : "transparent",
              color: activeTab === tab.id ? TAB_COLORS[tab.id] : "var(--muted-foreground)",
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              cursor: "pointer",
              minWidth: 44,
              minHeight: 36,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Chart card */}
      <div style={chartCardStyle}>
        {error && (
          <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(127,29,29,0.35)", color: "#fca5a5", fontSize: 14, marginBottom: 12 }}>
            {error}
          </div>
        )}
        {loading ? (
          <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted-foreground)", fontSize: 14 }}>
            読み込み中...
          </div>
        ) : series.length === 0 ? (
          <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted-foreground)", fontSize: 14 }}>
            この期間にデータはありません
          </div>
        ) : (
          <div style={{ height: 220 }}>
            {isBarChart ? (
              <Bar data={chartData} options={chartOptions} />
            ) : (
              <Line data={chartData} options={chartOptions} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
