import { useState, useEffect, useCallback } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";
import type { AnalyticsSummaryResponse, Tenant } from "../analytics/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KnowledgeItem {
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
  items: KnowledgeItem[];
  summary: {
    total_chunks_used: number;
    avg_conversion_rate: number;
    top_performer: KnowledgeItem | null;
    worst_performer: KnowledgeItem | null;
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LearningCycleFlow() {
  const steps = [
    { icon: "💬", label: "ユーザーの質問", sub: "会話が始まる" },
    { icon: "🔍", label: "知識を検索", sub: "RAGで照合" },
    { icon: "⚠️", label: "ギャップ記録", sub: "未回答を検出" },
    { icon: "📝", label: "知識データ追加", sub: "管理者が登録" },
    { icon: "✅", label: "回答に活用", sub: "次回から精度UP" },
  ];

  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: "20px 24px",
        marginBottom: 24,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 16, letterSpacing: "0.05em" }}>
        AI 学習サイクル
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch" as const,
        }}
      >
        {steps.map((step, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                padding: "12px 16px",
                borderRadius: 12,
                background: i === 2 ? "rgba(239,68,68,0.1)" : i === 4 ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${i === 2 ? "rgba(239,68,68,0.25)" : i === 4 ? "rgba(34,197,94,0.25)" : "var(--border)"}`,
                minWidth: 96,
              }}
            >
              <span style={{ fontSize: 22 }}>{step.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--foreground)", textAlign: "center", whiteSpace: "nowrap" }}>
                {step.label}
              </span>
              <span style={{ fontSize: 10, color: "#9ca3af", textAlign: "center" }}>{step.sub}</span>
            </div>
            {i < steps.length - 1 && (
              <div style={{ padding: "0 6px", color: "#4ade80", fontSize: 18, fontWeight: 700 }}>→</div>
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, padding: "8px 12px", borderRadius: 8, background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.12)" }}>
        <span style={{ fontSize: 12, color: "#86efac" }}>
          ギャップが知識に変わるたびに、回答の品質と成約率が向上します。
        </span>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value, sub, accent }: {
  icon: string; label: string; value: string; sub?: string; accent?: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 160,
        background: "var(--card)",
        border: `1px solid ${accent ? "rgba(34,197,94,0.35)" : "var(--border)"}`,
        borderRadius: 14,
        padding: "16px 18px",
      }}
    >
      <div style={{ fontSize: 20, marginBottom: 6 }}>{icon}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ? "#4ade80" : "var(--foreground)" }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function TrendBadge({ trend }: { trend: "up" | "down" | "stable" }) {
  if (trend === "up") return <span style={{ color: "#4ade80", fontSize: 14 }}>↑</span>;
  if (trend === "down") return <span style={{ color: "#ef4444", fontSize: 14 }}>↓</span>;
  return <span style={{ color: "#6b7280", fontSize: 14 }}>—</span>;
}

function ConversionBar({ rate }: { rate: number }) {
  const pct = Math.min(rate * 100, 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 72, height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 99, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: pct >= 50 ? "#4ade80" : pct >= 25 ? "#facc15" : "#f87171",
            borderRadius: 99,
          }}
        />
      </div>
      <span style={{ fontSize: 12, color: "var(--foreground)", whiteSpace: "nowrap" }}>
        {(pct).toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function KnowledgeAnalyticsPage() {
  const { user, isSuperAdmin, previewMode, previewTenantId } = useAuth();

  const [period, setPeriod] = useState<"7d" | "30d" | "90d">("30d");
  const [sourceType, setSourceType] = useState<"all" | "faq" | "book">("all");
  const [sortBy, setSortBy] = useState<"conversion_rate" | "usage_count" | "judge_score">("conversion_rate");
  const [tenantFilter, setTenantFilter] = useState<string>("");
  const [tenants, setTenants] = useState<Tenant[]>([]);

  const [attribution, setAttribution] = useState<AttributionResponse | null>(null);
  const [summary, setSummary] = useState<AnalyticsSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // テナントIDの解決
  const effectiveTenantId: string | undefined = (() => {
    if (previewMode && previewTenantId) return previewTenantId;
    if (!isSuperAdmin) return user?.tenantId ?? undefined;
    return tenantFilter || undefined;
  })();

  // スーパー管理者用テナント一覧
  useEffect(() => {
    if (!isSuperAdmin || previewMode) return;
    authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((r) => r.json() as Promise<{ tenants?: Tenant[]; items?: Tenant[] }>)
      .then((d) => setTenants(d.tenants ?? d.items ?? []))
      .catch(() => {});
  }, [isSuperAdmin, previewMode]);

  const fetchData = useCallback(async () => {
    if (!effectiveTenantId) return;
    setLoading(true);
    setError(null);
    try {
      const attrUrl = `${API_BASE}/v1/admin/analytics/knowledge-attribution?tenant_id=${effectiveTenantId}&period=${period}&source_type=${sourceType}&sort_by=${sortBy}&limit=50`;
      const summaryUrl = `${API_BASE}/v1/admin/analytics/summary?period=${period}${effectiveTenantId ? `&tenant=${effectiveTenantId}` : ""}`;

      const [attrRes, summaryRes] = await Promise.all([
        authFetch(attrUrl),
        authFetch(summaryUrl),
      ]);

      if (!attrRes.ok || !summaryRes.ok) throw new Error("データの取得に失敗しました");

      const [attrData, summaryData] = await Promise.all([
        attrRes.json() as Promise<AttributionResponse>,
        summaryRes.json() as Promise<AnalyticsSummaryResponse>,
      ]);

      setAttribution(attrData);
      setSummary(summaryData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, [effectiveTenantId, period, sourceType, sortBy]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const avgCvPct = attribution ? (attribution.summary.avg_conversion_rate * 100).toFixed(1) : "—";
  const totalChunks = attribution?.summary.total_chunks_used ?? "—";
  const topTitle = attribution?.summary.top_performer?.title ?? "—";
  const gapCount = summary?.total_knowledge_gaps ?? "—";

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
      {/* ヘッダー */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
          🧠 AI学習・貢献分析
        </h1>
        <p style={{ fontSize: 13, color: "#9ca3af", marginTop: 6 }}>
          OpenClawがどう学習し、各テナントの回答・成約にどう貢献しているかを確認できます。
        </p>
      </div>

      {/* コントロール */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 }}>
        {/* テナント選択 (スーパー管理者のみ) */}
        {isSuperAdmin && !previewMode && (
          <select
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--card)",
              color: "var(--foreground)",
              fontSize: 13,
            }}
          >
            <option value="">テナントを選択</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}

        {/* 期間 */}
        {(["7d", "30d", "90d"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: period === p ? "rgba(34,197,94,0.15)" : "var(--card)",
              color: period === p ? "#4ade80" : "#9ca3af",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {p === "7d" ? "7日" : p === "30d" ? "30日" : "90日"}
          </button>
        ))}

        {/* ソース */}
        {(["all", "faq", "book"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSourceType(s)}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: sourceType === s ? "rgba(99,102,241,0.15)" : "var(--card)",
              color: sourceType === s ? "#818cf8" : "#9ca3af",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {s === "all" ? "すべて" : s === "faq" ? "FAQ" : "書籍"}
          </button>
        ))}
      </div>

      {/* テナント未選択ガード (スーパー管理者) */}
      {isSuperAdmin && !previewMode && !tenantFilter && (
        <div
          style={{
            padding: "32px 24px",
            borderRadius: 14,
            border: "1px solid var(--border)",
            background: "var(--card)",
            textAlign: "center",
            color: "#9ca3af",
            fontSize: 14,
          }}
        >
          テナントを選択してください
        </div>
      )}

      {effectiveTenantId && (
        <>
          {/* 学習サイクル */}
          <LearningCycleFlow />

          {/* KPI カード */}
          {loading ? (
            <div style={{ color: "#9ca3af", fontSize: 14, marginBottom: 24 }}>⏳ 読み込み中...</div>
          ) : error ? (
            <div style={{ color: "#f87171", fontSize: 14, marginBottom: 24 }}>⚠️ {error}</div>
          ) : (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
                <KpiCard
                  icon="📚"
                  label="活用された知識チャンク"
                  value={String(totalChunks)}
                  sub={`期間: ${period}`}
                />
                <KpiCard
                  icon="🎯"
                  label="平均CV貢献率"
                  value={`${avgCvPct}%`}
                  sub="成約に至った会話の割合"
                  accent={parseFloat(avgCvPct) > 30}
                />
                <KpiCard
                  icon="⚠️"
                  label="未回答ギャップ"
                  value={String(gapCount)}
                  sub="知識追加の機会"
                />
                <KpiCard
                  icon="🏆"
                  label="最高貢献ナレッジ"
                  value={topTitle.length > 24 ? topTitle.slice(0, 24) + "…" : topTitle}
                  sub={
                    attribution?.summary.top_performer
                      ? `CV率 ${(attribution.summary.top_performer.conversion_rate * 100).toFixed(1)}%`
                      : undefined
                  }
                />
              </div>

              {/* 貢献度ランキングテーブル */}
              <div
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  overflow: "hidden",
                }}
              >
                {/* テーブルヘッダー */}
                <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>知識貢献度ランキング</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(["conversion_rate", "usage_count", "judge_score"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setSortBy(s)}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          background: sortBy === s ? "rgba(34,197,94,0.12)" : "transparent",
                          color: sortBy === s ? "#4ade80" : "#6b7280",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {s === "conversion_rate" ? "CV率" : s === "usage_count" ? "活用数" : "評価"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* テーブル本体 */}
                {attribution && attribution.items.length === 0 ? (
                  <div style={{ padding: "32px 24px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
                    この期間にナレッジが活用されたデータがありません
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                          {["#", "ナレッジ", "種別", "活用", "会話", "CV率", "評価", "傾向"].map((h) => (
                            <th
                              key={h}
                              style={{
                                padding: "10px 14px",
                                textAlign: "left",
                                color: "#6b7280",
                                fontWeight: 600,
                                fontSize: 11,
                                whiteSpace: "nowrap",
                                borderBottom: "1px solid var(--border)",
                              }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {attribution?.items.map((item, i) => (
                          <tr
                            key={item.chunk_id}
                            style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                          >
                            <td style={{ padding: "10px 14px", color: "#6b7280", fontSize: 12 }}>
                              {i + 1}
                            </td>
                            <td style={{ padding: "10px 14px", maxWidth: 260 }}>
                              <div style={{ fontWeight: 500, color: "var(--foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {item.title || "(タイトルなし)"}
                              </div>
                              {item.principle && (
                                <div style={{ fontSize: 10, color: "#818cf8", marginTop: 2 }}>{item.principle}</div>
                              )}
                            </td>
                            <td style={{ padding: "10px 14px" }}>
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: "2px 8px",
                                  borderRadius: 99,
                                  background: item.source === "book" ? "rgba(99,102,241,0.15)" : "rgba(34,197,94,0.1)",
                                  color: item.source === "book" ? "#818cf8" : "#4ade80",
                                }}
                              >
                                {item.source === "book" ? "書籍" : "FAQ"}
                              </span>
                            </td>
                            <td style={{ padding: "10px 14px", color: "var(--foreground)", textAlign: "right" }}>
                              {item.usage_count}
                            </td>
                            <td style={{ padding: "10px 14px", color: "var(--foreground)", textAlign: "right" }}>
                              {item.conversation_count}
                            </td>
                            <td style={{ padding: "10px 14px" }}>
                              <ConversionBar rate={item.conversion_rate} />
                            </td>
                            <td style={{ padding: "10px 14px", color: item.avg_judge_score && item.avg_judge_score >= 70 ? "#4ade80" : "#9ca3af", textAlign: "right" }}>
                              {item.avg_judge_score != null ? item.avg_judge_score.toFixed(1) : "—"}
                            </td>
                            <td style={{ padding: "10px 14px", textAlign: "center" }}>
                              <TrendBadge trend={item.trend} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* フッターノート */}
              {attribution && attribution.items.length > 0 && (
                <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    CV率：そのナレッジが使われた会話のうち成約に至った割合。↑↓は前期間比。評価スコアは Gemini Judge の平均点（100点満点）。
                  </span>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
