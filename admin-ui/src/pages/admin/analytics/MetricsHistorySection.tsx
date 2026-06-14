// admin-ui/src/pages/admin/analytics/MetricsHistorySection.tsx
// Phase72-D: Prometheus メトリクス時系列グラフ (super_admin only)

import { useState, useEffect } from "react";
import { Line, Bar } from "react-chartjs-2";
import { authFetch, API_BASE } from "../../../lib/api";
import { chartCardStyle } from "./utils";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

interface MetricsSeriesItem {
  timestamp: string;
  value: number;
  labels: Record<string, string>;
}

interface MetricsHistoryResponse {
  metric: string;
  period: string;
  granularity: string;
  series: MetricsSeriesItem[];
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

const PERIOD_OPTIONS = [
  { value: "1d", label: "1日" },
  { value: "7d", label: "7日" },
  { value: "30d", label: "30日" },
];

const GRANULARITY_OPTIONS = [
  { value: "1h", label: "1時間" },
  { value: "6h", label: "6時間" },
  { value: "24h", label: "1日" },
];

const TABS = [
  { id: "conversation", label: "会話・ループ" },
  { id: "avatar", label: "アバターリクエスト" },
  { id: "rag", label: "RAG 処理時間" },
] as const;

type TabId = typeof TABS[number]["id"];

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function groupByLabel(series: MetricsSeriesItem[]): Map<string, MetricsSeriesItem[]> {
  const map = new Map<string, MetricsSeriesItem[]>();
  for (const item of series) {
    const key = JSON.stringify(item.labels);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}

function labelDisplay(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "全体";
}

// ---------------------------------------------------------------------------
// useMetrics フック
// ---------------------------------------------------------------------------

function useMetrics(metric: string, period: string, granularity: string) {
  const [data, setData] = useState<MetricsHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ metric, period, granularity });
    authFetch(`${API_BASE}/v1/admin/analytics/metrics-history?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<MetricsHistoryResponse>;
      })
      .then(setData)
      .catch(() => setError("データの取得に失敗しました"))
      .finally(() => setLoading(false));
  }, [metric, period, granularity]);

  return { data, loading, error };
}

// ---------------------------------------------------------------------------
// 会話終了 vs ループ検出 グラフ（Line 2 系列）
// ---------------------------------------------------------------------------

function ConversationChart({ period, granularity }: { period: string; granularity: string }) {
  const terminal = useMetrics("rajiuce_conversation_terminal_total", period, granularity);
  const loop = useMetrics("rajiuce_loop_detected_total", period, granularity);

  const loading = terminal.loading || loop.loading;
  const error = terminal.error ?? loop.error;

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)" }}>読み込み中...</div>;
  if (error) return <div style={{ padding: 16, color: "#fca5a5" }}>データの取得に失敗しました</div>;

  const terminalSeries = terminal.data?.series ?? [];
  const loopSeries = loop.data?.series ?? [];

  // タイムスタンプ軸を統合
  const allTimestamps = Array.from(
    new Set([...terminalSeries.map((s) => s.timestamp), ...loopSeries.map((s) => s.timestamp)])
  ).sort();

  if (allTimestamps.length === 0) {
    return <div style={{ padding: 16, color: "var(--muted-foreground)", textAlign: "center" }}>データがありません</div>;
  }

  const terminalMap = new Map(terminalSeries.map((s) => [s.timestamp, s.value]));
  const loopMap = new Map(loopSeries.map((s) => [s.timestamp, s.value]));

  const chartData = {
    labels: allTimestamps.map(formatTimestamp),
    datasets: [
      {
        label: "会話終了（delta）",
        data: allTimestamps.map((t) => terminalMap.get(t) ?? 0),
        borderColor: "#60a5fa",
        backgroundColor: "rgba(96,165,250,0.08)",
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.3,
        fill: true,
      },
      {
        label: "ループ検出（delta）",
        data: allTimestamps.map((t) => loopMap.get(t) ?? 0),
        borderColor: "#f87171",
        backgroundColor: "rgba(248,113,113,0.08)",
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.3,
        fill: false,
      },
    ],
  };

  return (
    <div style={chartCardStyle}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
        会話終了数 vs ループ検出数
      </h3>
      <div style={{ height: 220 }}>
        <Line
          data={chartData}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: "bottom",
                labels: { color: "var(--muted-foreground)", font: { size: 11 }, padding: 10 },
              },
            },
            scales: {
              x: {
                ticks: { color: "var(--muted-foreground)", maxTicksLimit: 8, font: { size: 10 } },
                grid: { color: "rgba(255,255,255,0.05)" },
              },
              y: {
                beginAtZero: true,
                ticks: { color: "var(--muted-foreground)", font: { size: 11 } },
                grid: { color: "rgba(255,255,255,0.05)" },
              },
            },
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// アバターリクエスト グラフ（Bar stacked by result）
// ---------------------------------------------------------------------------

function AvatarRequestChart({ period, granularity }: { period: string; granularity: string }) {
  const { data, loading, error } = useMetrics("rajiuce_avatar_requests_total", period, granularity);

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)" }}>読み込み中...</div>;
  if (error) return <div style={{ padding: 16, color: "#fca5a5" }}>データの取得に失敗しました</div>;

  const series = data?.series ?? [];
  if (series.length === 0) {
    return <div style={{ padding: 16, color: "var(--muted-foreground)", textAlign: "center" }}>データがありません</div>;
  }

  // ラベル（result/status）別にグループ化
  const grouped = groupByLabel(series);
  const allTimestamps = Array.from(
    new Set(series.map((s) => s.timestamp))
  ).sort();

  const COLORS = ["rgba(52,211,153,0.75)", "rgba(248,113,113,0.75)", "rgba(251,191,36,0.75)", "rgba(167,139,250,0.75)"];
  const datasets = Array.from(grouped.entries()).map(([key, items], idx) => {
    const labels = JSON.parse(key) as Record<string, string>;
    const valueMap = new Map(items.map((s) => [s.timestamp, s.value]));
    return {
      label: labelDisplay(labels),
      data: allTimestamps.map((t) => valueMap.get(t) ?? 0),
      backgroundColor: COLORS[idx % COLORS.length],
      stack: "avatar",
    };
  });

  const chartData = {
    labels: allTimestamps.map(formatTimestamp),
    datasets,
  };

  return (
    <div style={chartCardStyle}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
        アバターリクエスト数（ラベル別）
      </h3>
      <div style={{ height: 220 }}>
        <Bar
          data={chartData}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: "bottom",
                labels: { color: "var(--muted-foreground)", font: { size: 11 }, padding: 10 },
              },
            },
            scales: {
              x: {
                stacked: true,
                ticks: { color: "var(--muted-foreground)", maxTicksLimit: 8, font: { size: 10 } },
                grid: { color: "rgba(255,255,255,0.05)" },
              },
              y: {
                stacked: true,
                beginAtZero: true,
                ticks: { color: "var(--muted-foreground)", font: { size: 11 } },
                grid: { color: "rgba(255,255,255,0.05)" },
              },
            },
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RAG 処理時間 グラフ（Line）
// ---------------------------------------------------------------------------

function RagDurationChart({ period, granularity }: { period: string; granularity: string }) {
  const { data, loading, error } = useMetrics("rajiuce_rag_duration_ms", period, granularity);

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)" }}>読み込み中...</div>;
  if (error) return <div style={{ padding: 16, color: "#fca5a5" }}>データの取得に失敗しました</div>;

  const series = data?.series ?? [];
  if (series.length === 0) {
    return <div style={{ padding: 16, color: "var(--muted-foreground)", textAlign: "center" }}>データがありません</div>;
  }

  // phase ラベル別にグループ化
  const grouped = groupByLabel(series);
  const allTimestamps = Array.from(new Set(series.map((s) => s.timestamp))).sort();

  const COLORS = ["#a78bfa", "#60a5fa", "#34d399", "#fbbf24"];
  const datasets = Array.from(grouped.entries()).map(([key, items], idx) => {
    const labels = JSON.parse(key) as Record<string, string>;
    const valueMap = new Map(items.map((s) => [s.timestamp, s.value]));
    return {
      label: labelDisplay(labels),
      data: allTimestamps.map((t) => valueMap.get(t) ?? 0),
      borderColor: COLORS[idx % COLORS.length],
      backgroundColor: "transparent",
      borderWidth: 2,
      pointRadius: 2,
      tension: 0.3,
    };
  });

  const chartData = {
    labels: allTimestamps.map(formatTimestamp),
    datasets,
  };

  return (
    <div style={chartCardStyle}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px 0" }}>
        RAG 処理時間（平均 ms / フェーズ別）
      </h3>
      <div style={{ height: 220 }}>
        <Line
          data={chartData}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: "bottom",
                labels: { color: "var(--muted-foreground)", font: { size: 11 }, padding: 10 },
              },
            },
            scales: {
              x: {
                ticks: { color: "var(--muted-foreground)", maxTicksLimit: 8, font: { size: 10 } },
                grid: { color: "rgba(255,255,255,0.05)" },
              },
              y: {
                beginAtZero: true,
                ticks: {
                  color: "var(--muted-foreground)",
                  font: { size: 11 },
                  callback: (v) => `${v}ms`,
                },
                grid: { color: "rgba(255,255,255,0.05)" },
              },
            },
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export function MetricsHistorySection() {
  const [activeTab, setActiveTab] = useState<TabId>("conversation");
  const [period, setPeriod] = useState("7d");
  const [granularity, setGranularity] = useState("1h");

  const selectStyle = {
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--card)",
    color: "var(--foreground)",
    fontSize: 13,
  };

  const tabStyle = (active: boolean) => ({
    padding: "6px 14px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer" as const,
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    background: active ? "rgba(96,165,250,0.2)" : "transparent",
    color: active ? "#60a5fa" : "var(--muted-foreground)",
  });

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: "var(--foreground)", margin: 0 }}>
          Prometheus メトリクス履歴
        </h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select style={selectStyle} value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select style={selectStyle} value={granularity} onChange={(e) => setGranularity(e.target.value)}>
            {GRANULARITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* タブ */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid var(--border)", paddingBottom: 4 }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            style={tabStyle(activeTab === tab.id)}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* グラフ */}
      {activeTab === "conversation" && (
        <ConversationChart period={period} granularity={granularity} />
      )}
      {activeTab === "avatar" && (
        <AvatarRequestChart period={period} granularity={granularity} />
      )}
      {activeTab === "rag" && (
        <RagDurationChart period={period} granularity={granularity} />
      )}
    </section>
  );
}
