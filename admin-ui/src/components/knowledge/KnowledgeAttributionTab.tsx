// Phase68: ナレッジ別CV影響度タブ
// /v1/admin/analytics/knowledge-attribution を呼び出して
// FAQ/書籍チャンクの利用頻度・CV寄与を可視化する。

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Bar } from "react-chartjs-2";
import { authFetch, API_BASE } from "../../lib/api";

type Period = "7d" | "30d" | "90d";
type SourceType = "all" | "faq" | "book";
type SortBy = "conversion_rate" | "usage_count" | "judge_score";

interface AttributionItem {
  chunk_id: string;
  source: "faq" | "book";
  title: string;
  principle?: string;
  usage_count: number;
  conversation_count: number;
  conversion_count: number;
  conversion_rate: number;
  avg_judge_score: number | null;
  trend: "up" | "down" | "stable";
}

interface AttributionResponse {
  period: string;
  tenant_id: string;
  source_type: SourceType;
  sort_by: SortBy;
  items: AttributionItem[];
  summary: {
    total_chunks_used: number;
    avg_conversion_rate: number;
    top_performer: AttributionItem | null;
    worst_performer: AttributionItem | null;
  };
}

// ─── スタイル ─────────────────────────────────────────────────────────────────

const CARD: CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "18px",
};

const SELECT: CSSProperties = {
  padding: "10px 12px",
  minHeight: 44,
  borderRadius: 8,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 14,
};

const TH: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  color: "#9ca3af",
  fontWeight: 600,
  borderBottom: "1px solid #1f2937",
  cursor: "pointer",
  userSelect: "none",
};

const TD: CSSProperties = {
  padding: "10px 12px",
  fontSize: 13,
  color: "#e5e7eb",
  borderBottom: "1px solid rgba(31,41,55,0.5)",
  verticalAlign: "top",
};

function formatRate(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

function trendLabel(trend: AttributionItem["trend"]): { label: string; color: string } {
  switch (trend) {
    case "up":
      return { label: "▲ 上昇", color: "#4ade80" };
    case "down":
      return { label: "▼ 下降", color: "#f87171" };
    default:
      return { label: "→ 横這い", color: "#9ca3af" };
  }
}

function sourceLabel(source: "faq" | "book"): { label: string; color: string } {
  return source === "book"
    ? { label: "書籍", color: "#fbbf24" }
    : { label: "FAQ", color: "#60a5fa" };
}

// ─── コンポーネント本体 ───────────────────────────────────────────────────────

export default function KnowledgeAttributionTab({ tenantId }: { tenantId: string }) {
  const [period, setPeriod] = useState<Period>("30d");
  const [sourceType, setSourceType] = useState<SourceType>("all");
  const [sortBy, setSortBy] = useState<SortBy>("conversion_rate");
  const [data, setData] = useState<AttributionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        tenant_id: tenantId,
        period,
        source_type: sourceType,
        sort_by: sortBy,
      });
      const res = await authFetch(
        `${API_BASE}/v1/admin/analytics/knowledge-attribution?${params.toString()}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const json: AttributionResponse = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId, period, sourceType, sortBy]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Top10 棒グラフ用データ
  const top10BarData = useMemo(() => {
    if (!data) return null;
    const top10 = [...data.items]
      .sort((a, b) => b.conversion_rate - a.conversion_rate)
      .slice(0, 10);
    return {
      labels: top10.map((x) =>
        x.title.length > 20 ? `${x.title.slice(0, 20)}…` : x.title,
      ),
      datasets: [
        {
          label: "CV率 (%)",
          data: top10.map((x) => Number((x.conversion_rate * 100).toFixed(1))),
          backgroundColor: top10.map((x) =>
            x.source === "book" ? "rgba(251,191,36,0.7)" : "rgba(96,165,250,0.7)",
          ),
          borderColor: top10.map((x) =>
            x.source === "book" ? "#fbbf24" : "#60a5fa",
          ),
          borderWidth: 1,
        },
      ],
    };
  }, [data]);

  const top10BarOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: {
        display: true,
        text: "Top10 ナレッジ CV率比較",
        color: "#e5e7eb",
      },
    },
    scales: {
      x: {
        ticks: { color: "#9ca3af", font: { size: 10 } },
        grid: { color: "rgba(255,255,255,0.04)" },
      },
      y: {
        ticks: { color: "#9ca3af", callback: (v: unknown) => `${v}%` },
        grid: { color: "rgba(255,255,255,0.08)" },
      },
    },
  };

  return (
    <div>
      {/* フィルター */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: 20,
        }}
      >
        <div>
          <label
            style={{ display: "block", fontSize: 12, color: "#9ca3af", marginBottom: 4 }}
          >
            期間
          </label>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            style={SELECT}
          >
            <option value="7d">過去7日</option>
            <option value="30d">過去30日</option>
            <option value="90d">過去90日</option>
          </select>
        </div>
        <div>
          <label
            style={{ display: "block", fontSize: 12, color: "#9ca3af", marginBottom: 4 }}
          >
            ソース
          </label>
          <select
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as SourceType)}
            style={SELECT}
          >
            <option value="all">全て</option>
            <option value="faq">FAQ</option>
            <option value="book">書籍</option>
          </select>
        </div>
        <div>
          <label
            style={{ display: "block", fontSize: 12, color: "#9ca3af", marginBottom: 4 }}
          >
            並び順
          </label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            style={SELECT}
          >
            <option value="conversion_rate">CV率</option>
            <option value="usage_count">利用回数</option>
            <option value="judge_score">Judgeスコア</option>
          </select>
        </div>
      </div>

      {loading && <p style={{ color: "#9ca3af" }}>読み込み中…</p>}
      {error && (
        <p style={{ color: "#fca5a5", fontSize: 14 }}>
          エラー: {error}
        </p>
      )}

      {data && !loading && (
        <>
          {/* サマリーカード */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: 20,
            }}
          >
            <div style={CARD}>
              <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>利用ナレッジ数</p>
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#f9fafb",
                }}
              >
                {data.summary.total_chunks_used}
              </p>
            </div>
            <div style={CARD}>
              <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>平均CV率</p>
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#4ade80",
                }}
              >
                {formatRate(data.summary.avg_conversion_rate)}
              </p>
            </div>
            <div style={CARD}>
              <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>
                最高パフォーマー
              </p>
              {data.summary.top_performer ? (
                <>
                  <p
                    style={{
                      margin: "6px 0 2px",
                      fontSize: 14,
                      color: "#f9fafb",
                      lineHeight: 1.35,
                    }}
                  >
                    {data.summary.top_performer.title}
                  </p>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 13,
                      fontWeight: 700,
                      color: "#4ade80",
                    }}
                  >
                    CV率 {formatRate(data.summary.top_performer.conversion_rate)}
                  </p>
                </>
              ) : (
                <p style={{ margin: "6px 0 0", fontSize: 14, color: "#6b7280" }}>
                  データなし
                </p>
              )}
            </div>
          </div>

          {/* 棒グラフ */}
          {top10BarData && data.items.length > 0 && (
            <div style={{ ...CARD, marginBottom: 20, height: 320 }}>
              <Bar data={top10BarData} options={top10BarOptions} />
            </div>
          )}

          {/* テーブル */}
          <div
            style={{
              ...CARD,
              padding: 0,
              overflow: "auto",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 720,
              }}
            >
              <thead>
                <tr>
                  <th style={TH}>ナレッジ</th>
                  <th style={TH}>種別</th>
                  <th
                    style={TH}
                    onClick={() => setSortBy("usage_count")}
                    title="クリックで利用回数順"
                  >
                    利用回数
                  </th>
                  <th style={TH}>CV回数</th>
                  <th
                    style={TH}
                    onClick={() => setSortBy("conversion_rate")}
                    title="クリックでCV率順"
                  >
                    CV率
                  </th>
                  <th
                    style={TH}
                    onClick={() => setSortBy("judge_score")}
                    title="クリックでJudgeスコア順"
                  >
                    Judgeスコア
                  </th>
                  <th style={TH}>トレンド</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 && (
                  <tr>
                    <td style={{ ...TD, textAlign: "center", color: "#6b7280" }} colSpan={7}>
                      データがまだありません。RAGソース記録は Phase68 デプロイ以降の会話から蓄積されます。
                    </td>
                  </tr>
                )}
                {data.items.map((item) => {
                  const sLabel = sourceLabel(item.source);
                  const tLabel = trendLabel(item.trend);
                  return (
                    <tr key={`${item.source}:${item.chunk_id}`}>
                      <td style={TD}>
                        <div style={{ fontWeight: 600, color: "#f9fafb" }}>
                          {item.title}
                        </div>
                        {item.principle && (
                          <div
                            style={{ fontSize: 11, color: "#fbbf24", marginTop: 2 }}
                          >
                            原則: {item.principle}
                          </div>
                        )}
                      </td>
                      <td style={TD}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 700,
                            background: `${sLabel.color}22`,
                            color: sLabel.color,
                            border: `1px solid ${sLabel.color}`,
                          }}
                        >
                          {sLabel.label}
                        </span>
                      </td>
                      <td style={TD}>{item.usage_count}</td>
                      <td style={TD}>{item.conversion_count}</td>
                      <td style={{ ...TD, fontWeight: 700, color: "#4ade80" }}>
                        {formatRate(item.conversion_rate)}
                      </td>
                      <td style={TD}>
                        {item.avg_judge_score != null
                          ? item.avg_judge_score.toFixed(1)
                          : "—"}
                      </td>
                      <td style={{ ...TD, color: tLabel.color, fontWeight: 600 }}>
                        {tLabel.label}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
