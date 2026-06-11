import type { AnalyticsSummaryResponse } from "./types";
import { scoreColor, sentimentKpiColor, cardStyle } from "./utils";

interface AnalyticsKpiCardsProps {
  summary: AnalyticsSummaryResponse | null;
  knowledgeTop3AvgRate: number | null;
}

export function AnalyticsKpiCards({ summary, knowledgeTop3AvgRate }: AnalyticsKpiCardsProps) {
  return (
    <>
      {/* KPI Cards */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
        {/* 総会話数 */}
        <div style={cardStyle}>
          <span style={{ fontSize: 24 }}>💬</span>
          <span style={{ fontSize: 28, fontWeight: 700, color: "var(--foreground)", lineHeight: 1 }}>
            {summary?.total_sessions ?? "—"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>総会話数</span>
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
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>AI応答品質スコア</span>
          <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>/100</span>
        </div>

        {/* Knowledge Gap件数 */}
        <div style={cardStyle}>
          <span style={{ fontSize: 24 }}>🔍</span>
          <span style={{ fontSize: 28, fontWeight: 700, color: "var(--foreground)", lineHeight: 1 }}>
            {summary?.total_knowledge_gaps ?? "—"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>AIが答えられなかった質問</span>
          <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>件</span>
        </div>

        {/* アバター利用率 */}
        <div style={cardStyle}>
          <span style={{ fontSize: 24 }}>🤖</span>
          <span style={{ fontSize: 28, fontWeight: 700, color: "#a78bfa", lineHeight: 1 }}>
            {summary?.avatar_rate != null
              ? `${(summary.avatar_rate * 100).toFixed(1)}%`
              : "—"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>動画AI接客の利用割合</span>
          <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
            {summary?.avatar_session_count ?? 0}件 / 全会話
          </span>
        </div>

        {/* CV件数(30日) */}
        <div style={cardStyle}>
          <span style={{ fontSize: 24 }}>🛒</span>
          <span
            style={{
              fontSize: 28,
              fontWeight: 700,
              lineHeight: 1,
              color: summary?.cv_fired_status === "fired" ? "#34d399" : summary?.cv_fired_status === "not_fired" ? "#f87171" : "#f9fafb",
            }}
          >
            {summary?.cv_count_30d ?? "—"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>成約件数（30日）</span>
          <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
            ¥{(summary?.cv_total_value_30d ?? 0).toLocaleString("ja-JP")}
          </span>
        </div>

        {/* ナレッジ貢献度 (Phase68) */}
        <div style={cardStyle}>
          <span style={{ fontSize: 24 }}>📈</span>
          <span
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: knowledgeTop3AvgRate != null ? "#4ade80" : "#9ca3af",
              lineHeight: 1,
            }}
          >
            {knowledgeTop3AvgRate != null
              ? `${(knowledgeTop3AvgRate * 100).toFixed(1)}%`
              : "—"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>
            知識データの成約貢献度
          </span>
          <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
            Top3 平均成約率
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
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)" }}>お客様の反応</span>
                <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                  ポジティブ率
                </span>
              </>
            );
          })()}
        </div>
      </div>

      {/* CV タイプ別ブレイクダウン */}
      {summary && summary.cv_count_30d > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 24,
            padding: "12px 16px",
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--card)",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--muted-foreground)", alignSelf: "center", marginRight: 4 }}>成約の内訳:</span>
          {(
            [
              ["purchase", "購入", "#34d399"],
              ["inquiry", "問合せ", "#60a5fa"],
              ["reservation", "予約", "#a78bfa"],
              ["signup", "登録", "#fbbf24"],
              ["other", "その他", "#9ca3af"],
            ] as [keyof typeof summary.cv_types_breakdown, string, string][]
          )
            .filter(([key]) => summary.cv_types_breakdown[key] > 0)
            .map(([key, label, color]) => (
              <span
                key={key}
                style={{
                  padding: "3px 10px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  background: `${color}18`,
                  border: `1px solid ${color}44`,
                  color,
                }}
              >
                {label} {summary.cv_types_breakdown[key]}
              </span>
            ))}
        </div>
      )}
    </>
  );
}
