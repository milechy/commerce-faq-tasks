import { useState, useEffect, useCallback } from "react";
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
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";
import type {
  AnalyticsSummaryResponse,
  AnalyticsTrendsResponse,
  AnalyticsEvaluationsResponse,
  ConversionResponse,
  Tenant,
} from "./types";
import { sentimentColors } from "./utils";
import { AnalyticsHeader } from "./AnalyticsHeader";
import { AnalyticsKpiCards } from "./AnalyticsKpiCards";
import { TrendChartsSection } from "./TrendChartsSection";
import { QualityChartsRow } from "./QualityChartsRow";
import { LowScoreSessionsTable } from "./LowScoreSessionsTable";
import { ConversionSection } from "./ConversionSection";
import { AvatarSettingsSection } from "./AvatarSettingsSection";

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
  // Phase68: ナレッジ貢献度 — Top3 の平均 CV 率
  const [knowledgeTop3AvgRate, setKnowledgeTop3AvgRate] = useState<number | null>(null);

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

      // Phase68: ナレッジ貢献度（特定テナントが選ばれている場合のみ）
      const effectiveTenantId =
        tenantId ?? (isSuperAdmin && tenantFilter ? tenantFilter : undefined);
      if (effectiveTenantId) {
        try {
          const kaParams = new URLSearchParams({
            tenant_id: effectiveTenantId,
            period,
            sort_by: "conversion_rate",
            limit: "3",
          });
          const kaRes = await authFetch(
            `${API_BASE}/v1/admin/analytics/knowledge-attribution?${kaParams}`,
          );
          if (kaRes.ok) {
            const ka = (await kaRes.json()) as {
              items: Array<{ conversion_rate: number }>;
            };
            if (ka.items.length > 0) {
              const top3 = ka.items.slice(0, 3);
              const avg =
                top3.reduce((s, i) => s + (i.conversion_rate ?? 0), 0) / top3.length;
              setKnowledgeTop3AvgRate(avg);
            } else {
              setKnowledgeTop3AvgRate(null);
            }
          } else {
            setKnowledgeTop3AvgRate(null);
          }
        } catch {
          setKnowledgeTop3AvgRate(null);
        }
      } else {
        setKnowledgeTop3AvgRate(null);
      }
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
            borderColor: "var(--card)",
            borderWidth: 2,
          },
        ],
      }
    : null;

  const radarData = evaluations
    ? {
        labels: ["接客スタイルの適合度", "お客様の反応", "会話の進み具合", "禁止事項の遵守率"],
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
            borderColor: "var(--card)",
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
            borderColor: "var(--card)",
            borderWidth: 2,
          },
        ],
      }
    : null;

  const stageDropoutBarData = conversion
    ? {
        labels: ["clarify", "answer", "confirm", "terminal"].map((s) => ({
          clarify: "質問確認",
          answer: "回答",
          confirm: "クロージング",
          terminal: "完了",
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

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
        padding: "24px 20px",
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <AnalyticsHeader
        navigate={navigate}
        isSuperAdmin={isSuperAdmin}
        selectedTenantName={selectedTenantName}
        tenantFilter={tenantFilter}
        setTenantFilter={setTenantFilter}
        tenants={tenants}
        period={period}
        setPeriod={setPeriod}
      />

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
        <div style={{ padding: 60, textAlign: "center", color: "var(--muted-foreground)" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込み中...
        </div>
      ) : (
        <>
          <AnalyticsKpiCards summary={summary} knowledgeTop3AvgRate={knowledgeTop3AvgRate} />

          <TrendChartsSection lineData={lineData} stackedBarData={stackedBarData} />

          <QualityChartsRow
            doughnutData={doughnutData}
            radarData={radarData}
            sentimentPieData={sentimentPieData}
          />

          {/* Low Score Sessions Table */}
          {evaluations && evaluations.low_score_sessions.length > 0 && (
            <LowScoreSessionsTable evaluations={evaluations} navigate={navigate} />
          )}
          {/* ============================================================ */}
          {/* Phase52f: 成果・コンバージョン分析 */}
          {/* ============================================================ */}
          {conversion && (
            <ConversionSection
              conversion={conversion}
              convTrendLineData={convTrendLineData}
              outcomePieData={outcomePieData}
              stageDropoutBarData={stageDropoutBarData}
              sortedTechniques={sortedTechniques}
              techSortAsc={techSortAsc}
              setTechSortAsc={setTechSortAsc}
            />
          )}
          {/* ============================================================ */}
          {/* Phase72-B: アバター設定利用率分析 (super_admin only) */}
          {/* ============================================================ */}
          {isSuperAdmin && <AvatarSettingsSection />}
        </>
      )}
    </div>
  );
}
