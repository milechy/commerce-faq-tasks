import { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  RadialLinearScale,
  Filler,
} from "chart.js";
import { Line, Bar, Doughnut, Radar, Pie } from "react-chartjs-2";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  RadialLinearScale,
  Filler
);

// === API Response Types ===
interface AnalyticsSummaryResponse {
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
}

interface AnalyticsTrendsResponse {
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

interface AnalyticsEvaluationsResponse {
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
interface ConversionResponse {
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

interface Tenant {
  id: string;
  name: string;
}

const PERIOD_LABELS: Record<string, string> = {
  "7d": "7日",
  "30d": "30日",
  "90d": "90日",
};

const scoreColor = (score: number | null) => {
  if (score === null) return "#9ca3af";
  if (score >= 80) return "#4ade80";
  if (score >= 60) return "#fbbf24";
  return "#f87171";
};

const sentimentColors = {
  positive: "rgba(99, 153, 34, 0.8)",
  neutral: "rgba(136, 135, 128, 0.5)",
  negative: "rgba(226, 75, 74, 0.8)",
};

const sentimentKpiColor = (positiveRate: number) => {
  if (positiveRate >= 0.7) return "#4ade80";
  if (positiveRate >= 0.5) return "#fbbf24";
  return "#f87171";
};

export default function AnalyticsDashboardPage() {
  const navigate = useNavigate();
  const { user, isSuperAdmin, previewMode, previewTenantId } = useAuth();

  const [period, setPeriod] = useState<string>("30d");
  const [tenantFilter, setTenantFilter] = useState<string>("");
  const [tenants, setTenants] = useState<Tenant[]>([]);

  const [summary, setSummary] = useState<AnalyticsSummaryResponse | null>(null);
  const [trends, setTrends] = useState<AnalyticsTrendsResponse | null>(null);
  const [evaluations, setEvaluations] = useState<AnalyticsEvaluationsResponse | null>(null);
  const [conversion, setConversion] = useState<ConversionResponse | null>(null);
  const [techSortAsc, setTechSortAsc] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tenantId = isSuperAdmin && !previewMode
    ? undefined
    : (previewMode ? (previewTenantId ?? undefined) : (user?.tenantId ?? undefined));

  useEffect(() => {
    if (!isSuperAdmin) return;
    authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((res) => res.json() as Promise<{ tenants?: Tenant[]; items?: Tenant[] }>)
      .then((data) => setTenants(data.tenants ?? data.items ?? []))
      .catch(() => {/* テナント一覧取得失敗は無視 */});
  }, [isSuperAdmin]);

  const selectedTenantName =
    tenantFilter ? (tenants.find((t) => t.id === tenantFilter)?.name ?? tenantFilter) : "全テナント";

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ period });
    if (tenantId) params.set("tenant", tenantId);
    else if (isSuperAdmin && tenantFilter) params.set("tenant", tenantFilter);

    try {
      const [summaryRes, trendsRes, evalsRes, convRes] = await Promise.all([
        authFetch(`${API_BASE}/v1/admin/analytics/summary?${params}`),
        authFetch(`${API_BASE}/v1/admin/analytics/trends?${params}`),
        authFetch(`${API_BASE}/v1/admin/analytics/evaluations?${params}`),
        authFetch(`${API_BASE}/v1/admin/analytics/conversions?${params}`),
      ]);

      if (!summaryRes.ok || !trendsRes.ok || !evalsRes.ok || !convRes.ok) {
        throw new Error("データの読み込みに失敗しました");
      }

      setSummary((await summaryRes.json()) as AnalyticsSummaryResponse);
      setTrends((await trendsRes.json()) as AnalyticsTrendsResponse);
      setEvaluations((await evalsRes.json()) as AnalyticsEvaluationsResponse);
      setConversion((await convRes.json()) as ConversionResponse);
    } catch {
      setError("データの読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, [period, tenantId, isSuperAdmin, tenantFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("ja-JP", { month: "short", day: "numeric" });

  // Chart data
  const lineData = trends
    ? {
        labels: trends.daily.map((d) => formatDate(d.date)),
        datasets: [
          {
            label: "会話数",
            data: trends.daily.map((d) => d.sessions),
            borderColor: "#60a5fa",
            backgroundColor: "rgba(96,165,250,0.08)",
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.3,
            fill: true,
          },
        ],
      }
    : null;

  const doughnutData = evaluations
    ? {
        labels: evaluations.score_distribution.map((s) => s.range),
        datasets: [
          {
            data: evaluations.score_distribution.map((s) => s.count),
            backgroundColor: ["#f87171", "#fb923c", "#fbbf24", "#60a5fa", "#4ade80"],
            borderColor: "rgba(15,23,42,0.5)",
            borderWidth: 2,
          },
        ],
      }
    : null;

  const radarData = evaluations
    ? {
        labels: ["心理学適合", "顧客反応", "ステージ進行", "タブー違反"],
        datasets: [
          {
            label: "平均スコア",
            data: [
              evaluations.axis_averages.psychology_fit,
              evaluations.axis_averages.customer_reaction,
              evaluations.axis_averages.stage_progress,
              evaluations.axis_averages.taboo_violation,
            ],
            borderColor: "#a78bfa",
            backgroundColor: "rgba(167,139,250,0.15)",
            borderWidth: 2,
            pointBackgroundColor: "#a78bfa",
          },
        ],
      }
    : null;

  const stackedBarData = trends
    ? {
        labels: trends.daily.map((d) => formatDate(d.date)),
        datasets: [
          {
            label: "ポジティブ",
            data: trends.daily.map((d) => d.sentiment_positive),
            backgroundColor: sentimentColors.positive,
            stack: "sentiment",
          },
          {
            label: "ニュートラル",
            data: trends.daily.map((d) => d.sentiment_neutral),
            backgroundColor: sentimentColors.neutral,
            stack: "sentiment",
          },
          {
            label: "ネガティブ",
            data: trends.daily.map((d) => d.sentiment_negative),
            backgroundColor: sentimentColors.negative,
            stack: "sentiment",
          },
        ],
      }
    : null;

  const sentimentPieData = summary?.sentiment_distribution
    ? {
        labels: ["ポジティブ", "ニュートラル", "ネガティブ"],
        datasets: [
          {
            data: [
              summary.sentiment_distribution.positive,
              summary.sentiment_distribution.neutral,
              summary.sentiment_distribution.negative,
            ],
            backgroundColor: [
              sentimentColors.positive,
              sentimentColors.neutral,
              sentimentColors.negative,
            ],
            borderColor: "rgba(15,23,42,0.5)",
            borderWidth: 2,
          },
        ],
      }
    : null;

  // Phase52f: Conversion chart data
  const convTrendLineData = conversion
    ? {
        labels: conversion.conversion_rate_trend.map((d) => formatDate(d.date)),
        datasets: [
          {
            label: "コンバージョン率 (%)",
            data: conversion.conversion_rate_trend.map((d) => d.rate),
            borderColor: "#34d399",
            backgroundColor: "rgba(52,211,153,0.08)",
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.3,
            fill: true,
          },
        ],
      }
    : null;

  const outcomeNames = conversion ? Object.keys(conversion.summary.outcomes) : [];
  const outcomePieData = conversion && outcomeNames.length > 0
    ? {
        labels: outcomeNames,
        datasets: [
          {
            data: outcomeNames.map((k) => conversion.summary.outcomes[k]),
            backgroundColor: [
              "rgba(52,211,153,0.8)",
              "rgba(96,165,250,0.8)",
              "rgba(251,191,36,0.8)",
              "rgba(248,113,113,0.8)",
              "rgba(167,139,250,0.8)",
            ],
            borderColor: "rgba(15,23,42,0.5)",
            borderWidth: 2,
          },
        ],
      }
    : null;

  const stageDropoutBarData = conversion
    ? {
        labels: ["clarify", "answer", "confirm", "terminal"].map((s) => ({
          clarify: "クラリファイ",
          answer: "アンサー",
          confirm: "コンファーム",
          terminal: "ターミナル",
        }[s] ?? s)),
        datasets: [
          {
            label: "離脱セッション数",
            data: ["clarify", "answer", "confirm", "terminal"].map(
              (s) => conversion.stage_dropout[s] ?? 0,
            ),
            backgroundColor: "rgba(248,113,113,0.75)",
            borderRadius: 6,
          },
        ],
      }
    : null;

  const sortedTechniques = conversion
    ? [...conversion.technique_effectiveness].sort((a, b) =>
        techSortAsc
          ? a.conversion_rate - b.conversion_rate
          : b.conversion_rate - a.conversion_rate,
      )
    : [];

  const cardStyle: CSSProperties = {
    flex: "1 1 160px",
    borderRadius: 14,
    border: "1px solid #1f2937",
    background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
    padding: "20px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
  };

  const chartCardStyle: CSSProperties = {
    borderRadius: 14,
    border: "1px solid #1f2937",
    background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
    padding: "20px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
    marginBottom: 20,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 28,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{
              background: "none",
              border: "none",
              color: "#9ca3af",
              fontSize: 14,
              cursor: "pointer",
              padding: 0,
              marginBottom: 8,
              display: "block",
            }}
          >
            ← 管理画面へ戻る
          </button>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            📈 会話分析ダッシュボード
            {isSuperAdmin && (
              <span style={{ fontSize: 16, fontWeight: 400, color: "#9ca3af", marginLeft: 10 }}>
                — {selectedTenantName}
              </span>
            )}
          </h1>
          <p style={{ fontSize: 13, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            KPI・トレンド・センチメントを可視化します
          </p>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {isSuperAdmin && (
            <select
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb",
                fontSize: 14,
                minWidth: 160,
                minHeight: 44,
                cursor: "pointer",
              }}
            >
              <option value="">全テナント</option>
              {tenants
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, "ja"))
                .map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
            </select>
          )}
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: "rgba(15,23,42,0.8)",
              color: "#e5e7eb",
              fontSize: 14,
              minHeight: 44,
              cursor: "pointer",
            }}
          >
            {Object.entries(PERIOD_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
      </header>

      {/* Error */}
      {error && (
        <div
          style={{
            marginBottom: 20,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 15,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 60, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込み中...
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
            {/* 総会話数 */}
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>💬</span>
              <span style={{ fontSize: 28, fontWeight: 700, color: "#f9fafb", lineHeight: 1 }}>
                {summary?.total_sessions ?? "—"}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>総会話数</span>
              {summary && (
                <span
                  style={{
                    fontSize: 12,
                    color: summary.sessions_change_pct >= 0 ? "#4ade80" : "#f87171",
                    fontWeight: 600,
                  }}
                >
                  {summary.sessions_change_pct >= 0 ? "▲" : "▼"}{" "}
                  {Math.abs(summary.sessions_change_pct).toFixed(1)}% 前期比
                </span>
              )}
            </div>

            {/* 平均Judgeスコア */}
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>⭐</span>
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: scoreColor(summary?.avg_judge_score ?? null),
                  lineHeight: 1,
                }}
              >
                {summary?.avg_judge_score != null
                  ? `${summary.avg_judge_score.toFixed(1)}`
                  : "—"}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>平均Judgeスコア</span>
              <span style={{ fontSize: 12, color: "#6b7280" }}>/100</span>
            </div>

            {/* Knowledge Gap件数 */}
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>🔍</span>
              <span style={{ fontSize: 28, fontWeight: 700, color: "#f9fafb", lineHeight: 1 }}>
                {summary?.total_knowledge_gaps ?? "—"}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>Knowledge Gap</span>
              <span style={{ fontSize: 12, color: "#6b7280" }}>件</span>
            </div>

            {/* アバター利用率 */}
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>🤖</span>
              <span style={{ fontSize: 28, fontWeight: 700, color: "#a78bfa", lineHeight: 1 }}>
                {summary?.avatar_rate != null
                  ? `${(summary.avatar_rate * 100).toFixed(1)}%`
                  : "—"}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>アバター利用率</span>
              <span style={{ fontSize: 12, color: "#6b7280" }}>
                {summary?.avatar_session_count ?? 0}件 / 全会話
              </span>
            </div>

            {/* 顧客感情 */}
            <div style={cardStyle}>
              <span style={{ fontSize: 24 }}>😊</span>
              {(() => {
                const dist = summary?.sentiment_distribution;
                const positiveRate =
                  dist && dist.total > 0 ? dist.positive / dist.total : null;
                return (
                  <>
                    <span
                      style={{
                        fontSize: 28,
                        fontWeight: 700,
                        color: positiveRate != null
                          ? sentimentKpiColor(positiveRate)
                          : "#9ca3af",
                        lineHeight: 1,
                      }}
                    >
                      {positiveRate != null
                        ? `${(positiveRate * 100).toFixed(1)}%`
                        : "—"}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>顧客感情</span>
                    <span style={{ fontSize: 12, color: "#6b7280" }}>
                      ポジティブ率
                    </span>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Line Chart: 会話数トレンド */}
          {lineData && (
            <div style={chartCardStyle}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "#d1d5db", margin: "0 0 16px 0" }}>
                会話数トレンド
              </h3>
              <div style={{ height: 220 }}>
                <Line
                  data={lineData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                      x: {
                        ticks: { color: "#6b7280", maxTicksLimit: 8, font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                      },
                      y: {
                        ticks: { color: "#6b7280", font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                        beginAtZero: true,
                      },
                    },
                  }}
                />
              </div>
            </div>
          )}

          {/* Sentiment Stacked Bar Chart */}
          {stackedBarData && (
            <div style={chartCardStyle}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "#d1d5db", margin: "0 0 16px 0" }}>
                センチメント推移
              </h3>
              <div style={{ height: 220 }}>
                <Bar
                  data={stackedBarData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                      legend: {
                        position: "bottom",
                        labels: { color: "#9ca3af", font: { size: 11 }, padding: 10 },
                      },
                    },
                    scales: {
                      x: {
                        stacked: true,
                        ticks: { color: "#6b7280", maxTicksLimit: 8, font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                      },
                      y: {
                        stacked: true,
                        ticks: { color: "#6b7280", font: { size: 11 } },
                        grid: { color: "rgba(255,255,255,0.05)" },
                        beginAtZero: true,
                      },
                    },
                  }}
                />
              </div>
            </div>
          )}

          {/* Charts row: Doughnut + Radar */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              marginBottom: 20,
            }}
          >
            {/* Doughnut: スコア分布 */}
            {doughnutData && (
              <div style={{ ...chartCardStyle, flex: "1 1 280px", marginBottom: 0 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#d1d5db", margin: "0 0 16px 0" }}>
                  Judgeスコア分布
                </h3>
                <div style={{ height: 200, display: "flex", justifyContent: "center" }}>
                  <Doughnut
                    data={doughnutData}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                        legend: {
                          position: "bottom",
                          labels: { color: "#9ca3af", font: { size: 11 }, padding: 10 },
                        },
                      },
                    }}
                  />
                </div>
              </div>
            )}

            {/* Radar: 4軸平均 */}
            {radarData && (
              <div style={{ ...chartCardStyle, flex: "1 1 280px", marginBottom: 0 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#d1d5db", margin: "0 0 16px 0" }}>
                  4軸平均スコア
                </h3>
                <div style={{ height: 200 }}>
                  <Radar
                    data={radarData}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      scales: {
                        r: {
                          min: 0,
                          max: 100,
                          ticks: { color: "#6b7280", font: { size: 10 }, stepSize: 25 },
                          grid: { color: "rgba(255,255,255,0.08)" },
                          angleLines: { color: "rgba(255,255,255,0.08)" },
                          pointLabels: { color: "#9ca3af", font: { size: 11 } },
                        },
                      },
                      plugins: {
                        legend: { display: false },
                      },
                    }}
                  />
                </div>
              </div>
            )}

            {/* Pie: センチメント分布 */}
            {sentimentPieData && (
              <div style={{ ...chartCardStyle, flex: "1 1 280px", marginBottom: 0 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#d1d5db", margin: "0 0 16px 0" }}>
                  センチメント分布
                </h3>
                <div style={{ height: 200, display: "flex", justifyContent: "center" }}>
                  <Pie
                    data={sentimentPieData}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                        legend: {
                          position: "bottom",
                          labels: { color: "#9ca3af", font: { size: 11 }, padding: 10 },
                        },
                      },
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Low Score Sessions Table */}
          {evaluations && evaluations.low_score_sessions.length > 0 && (
            <div style={chartCardStyle}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "#d1d5db", margin: "0 0 16px 0" }}>
                低スコア会話
              </h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #1f2937" }}>
                      {["セッションID", "スコア", "評価日時", "メッセージ数", "フィードバック"].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: "8px 12px",
                            textAlign: "left",
                            color: "#6b7280",
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
                        <td style={{ padding: "10px 12px", color: "#9ca3af", whiteSpace: "nowrap" }}>
                          {new Date(s.evaluated_at).toLocaleDateString("ja-JP", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td style={{ padding: "10px 12px", color: "#9ca3af", textAlign: "center" }}>
                          {s.message_count}
                        </td>
                        <td
                          style={{
                            padding: "10px 12px",
                            color: "#d1d5db",
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
          )}
          {/* ============================================================ */}
          {/* Phase52f: 成果・コンバージョン分析 */}
          {/* ============================================================ */}
          {conversion && (
            <>
              <h2
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: "#f9fafb",
                  marginTop: 40,
                  marginBottom: 16,
                  borderBottom: "1px solid #1f2937",
                  paddingBottom: 10,
                }}
              >
                🎯 成果・コンバージョン分析
              </h2>

              {/* KPI Cards */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
                <div style={cardStyle}>
                  <span style={{ fontSize: 24 }}>📊</span>
                  <span style={{ fontSize: 28, fontWeight: 700, color: "#f9fafb", lineHeight: 1 }}>
                    {conversion.summary.total_sessions}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>総セッション数</span>
                </div>
                <div style={cardStyle}>
                  <span style={{ fontSize: 24 }}>✅</span>
                  <span style={{ fontSize: 28, fontWeight: 700, color: "#34d399", lineHeight: 1 }}>
                    {conversion.summary.recorded_outcomes}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>記録済み成果</span>
                </div>
                <div style={cardStyle}>
                  <span style={{ fontSize: 24 }}>📝</span>
                  <span
                    style={{
                      fontSize: 28,
                      fontWeight: 700,
                      lineHeight: 1,
                      color:
                        conversion.summary.recording_rate >= 70
                          ? "#4ade80"
                          : conversion.summary.recording_rate >= 40
                          ? "#fbbf24"
                          : "#f87171",
                    }}
                  >
                    {conversion.summary.recording_rate.toFixed(1)}%
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>記録率</span>
                </div>
                {/* コンバージョン率: 離脱・不明を除いた割合 */}
                {(() => {
                  const positiveCount = Object.entries(conversion.summary.outcomes)
                    .filter(([k]) => k !== "離脱" && k !== "不明")
                    .reduce((sum, [, v]) => sum + v, 0);
                  const convRate =
                    conversion.summary.total_sessions > 0
                      ? (positiveCount / conversion.summary.total_sessions) * 100
                      : 0;
                  return (
                    <div style={cardStyle}>
                      <span style={{ fontSize: 24 }}>🏆</span>
                      <span
                        style={{
                          fontSize: 28,
                          fontWeight: 700,
                          lineHeight: 1,
                          color:
                            convRate >= 30 ? "#4ade80" : convRate >= 15 ? "#fbbf24" : "#f87171",
                        }}
                      >
                        {convRate.toFixed(1)}%
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>コンバージョン率</span>
                      <span style={{ fontSize: 12, color: "#6b7280" }}>離脱・不明を除く</span>
                    </div>
                  );
                })()}
              </div>

              {/* Trend + Outcome row */}
              <div style={{ display: "flex", gap: 20, marginBottom: 20, flexWrap: "wrap" }}>
                {/* Conversion rate trend */}
                {convTrendLineData && (
                  <div style={{ ...chartCardStyle, flex: "2 1 320px", marginBottom: 0 }}>
                    <div style={{ fontWeight: 600, color: "#d1d5db", marginBottom: 12, fontSize: 14 }}>
                      コンバージョン率推移
                    </div>
                    <div style={{ height: 200 }}>
                      <Line
                        data={convTrendLineData}
                        options={{
                          responsive: true,
                          maintainAspectRatio: false,
                          plugins: { legend: { display: false } },
                          scales: {
                            x: {
                              ticks: { color: "#6b7280", maxTicksLimit: 7 },
                              grid: { color: "rgba(75,85,99,0.2)" },
                            },
                            y: {
                              ticks: { color: "#6b7280", callback: (v) => `${v}%` },
                              grid: { color: "rgba(75,85,99,0.2)" },
                              min: 0,
                            },
                          },
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Outcome pie */}
                {outcomePieData && (
                  <div style={{ ...chartCardStyle, flex: "1 1 220px", marginBottom: 0 }}>
                    <div style={{ fontWeight: 600, color: "#d1d5db", marginBottom: 12, fontSize: 14 }}>
                      成果内訳
                    </div>
                    <div style={{ height: 200 }}>
                      <Doughnut
                        data={outcomePieData}
                        options={{
                          responsive: true,
                          maintainAspectRatio: false,
                          plugins: {
                            legend: {
                              position: "bottom",
                              labels: { color: "#9ca3af", font: { size: 11 }, boxWidth: 12 },
                            },
                          },
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Technique effectiveness table */}
              {sortedTechniques.length > 0 && (
                <div style={{ ...chartCardStyle }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 12,
                    }}
                  >
                    <span style={{ fontWeight: 600, color: "#d1d5db", fontSize: 14 }}>
                      テクニック別効果
                    </span>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr>
                          {["テクニック", "使用セッション", "コンバージョン"].map((h) => (
                            <th
                              key={h}
                              style={{
                                padding: "8px 12px",
                                textAlign: "left",
                                color: "#6b7280",
                                fontWeight: 600,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {h}
                            </th>
                          ))}
                          <th
                            style={{
                              padding: "8px 12px",
                              textAlign: "left",
                              color: "#6b7280",
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                              cursor: "pointer",
                              userSelect: "none",
                            }}
                            onClick={() => setTechSortAsc((p) => !p)}
                          >
                            CVR {techSortAsc ? "▲" : "▼"}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTechniques.map((t) => (
                          <tr key={t.technique} style={{ borderBottom: "1px solid rgba(31,41,55,0.5)" }}>
                            <td style={{ padding: "10px 12px", fontWeight: 600, color: "#e5e7eb" }}>
                              {t.technique}
                            </td>
                            <td style={{ padding: "10px 12px", color: "#9ca3af", textAlign: "center" }}>
                              {t.sessions_used}
                            </td>
                            <td style={{ padding: "10px 12px", color: "#9ca3af", textAlign: "center" }}>
                              {t.converted}
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <span
                                style={{
                                  fontWeight: 700,
                                  color:
                                    t.conversion_rate >= 60
                                      ? "#4ade80"
                                      : t.conversion_rate >= 30
                                      ? "#fbbf24"
                                      : "#f87171",
                                }}
                              >
                                {t.conversion_rate.toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Stage dropout bar chart */}
              {stageDropoutBarData && (
                <div style={chartCardStyle}>
                  <div style={{ fontWeight: 600, color: "#d1d5db", marginBottom: 12, fontSize: 14 }}>
                    ステージ別離脱分析
                  </div>
                  <div style={{ height: 180 }}>
                    <Bar
                      data={stageDropoutBarData}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                          x: {
                            ticks: { color: "#9ca3af" },
                            grid: { display: false },
                          },
                          y: {
                            ticks: { color: "#6b7280" },
                            grid: { color: "rgba(75,85,99,0.2)" },
                          },
                        },
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
