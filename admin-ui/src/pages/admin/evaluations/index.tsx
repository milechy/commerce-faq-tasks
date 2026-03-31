import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

interface Tenant {
  id: string;
  name: string;
}

interface Evaluation {
  id: number;
  tenant_id: string;
  session_id: string;
  overall_score?: number;
  score: number;
  psychology_fit_score?: number;
  customer_reaction_score?: number;
  stage_progress_score?: number;
  taboo_violation_score?: number;
  feedback?: { summary?: string };
  suggested_rules?: Array<{ rule_text: string; reason: string; priority: string; status?: string }>;
  judge_model?: string;
  evaluated_at: string;
  model_used?: string;
}

const AXIS_META = [
  { key: "psychology_fit_score" as const, label: "心理対応力", weight: 30, tooltip: "顧客の心理状態に合わせた適切な対応力" },
  { key: "customer_reaction_score" as const, label: "顧客対応力", weight: 25, tooltip: "顧客の反応を引き出す力" },
  { key: "stage_progress_score" as const, label: "商談進行力", weight: 25, tooltip: "商談を次のステージへ進める力" },
  { key: "taboo_violation_score" as const, label: "NG行為チェック", weight: 20, tooltip: "タブーや禁止事項への違反チェック" },
] as const;

function scoreConfig(score: number) {
  if (score >= 80) return { bg: "rgba(34,197,94,0.15)", border: "rgba(34,197,94,0.3)", color: "#4ade80", label: "優秀" };
  if (score >= 60) return { bg: "rgba(251,191,36,0.15)", border: "rgba(251,191,36,0.3)", color: "#fbbf24", label: "良好" };
  if (score >= 40) return { bg: "rgba(251,146,60,0.15)", border: "rgba(251,146,60,0.3)", color: "#fb923c", label: "改善の余地あり" };
  return { bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.3)", color: "#f87171", label: "改善が必要です" };
}

function ScoreBadge({ score }: { score: number }) {
  const cfg = scoreConfig(score);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        color: cfg.color,
        whiteSpace: "nowrap",
      }}
    >
      総合スコア {score}/100 <span style={{ fontSize: 10, opacity: 0.8 }}>{cfg.label}</span>
    </span>
  );
}

export { ScoreBadge };

export default function EvaluationsPage() {
  const navigate = useNavigate();
  const { lang } = useLang();
  const { user, isSuperAdmin } = useAuth();

  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [total, setTotal] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minScore, setMinScore] = useState<number | "">("");
  const [maxScore, setMaxScore] = useState<number | "">("");
  const [days, setDays] = useState(30);
  const [tenantFilter, setTenantFilter] = useState("");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [offset, setOffset] = useState(0);

  const locale = lang === "en" ? "en-US" : "ja-JP";
  const tenantId = isSuperAdmin ? undefined : (user?.tenantId ?? undefined);

  useEffect(() => {
    if (!isSuperAdmin) return;
    authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((res) => res.json() as Promise<{ tenants?: Tenant[]; items?: Tenant[] }>)
      .then((data) => setTenants(data.tenants ?? data.items ?? []))
      .catch(() => {/* テナント一覧取得失敗は無視 */});
  }, [isSuperAdmin]);

  const loadEvaluations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (tenantId) params.set("tenant_id", tenantId);
      else if (isSuperAdmin && tenantFilter) params.set("tenant_id", tenantFilter);
      params.set("limit", "20");
      params.set("offset", String(offset));
      if (minScore !== "") params.set("min_score", String(minScore));
      if (maxScore !== "") params.set("max_score", String(maxScore));
      params.set("days", String(days));
      const res = await authFetch(`${API_BASE}/v1/admin/evaluations?${params}`);
      if (!res.ok) throw new Error("Failed to fetch evaluations");
      const data = (await res.json()) as { evaluations: Evaluation[]; total: number };
      const validEvaluations = (data.evaluations ?? []).filter(
        (e) => (e.overall_score ?? e.score) > 0
      );
      setEvaluations(validEvaluations);
      setTotal(data.total ?? 0);
    } catch {
      setError("データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [tenantId, isSuperAdmin, tenantFilter, offset, minScore, maxScore, days]);

  useEffect(() => {
    void loadEvaluations();
  }, [loadEvaluations]);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const avgScore =
    evaluations.length > 0
      ? Math.round(
          evaluations.reduce((sum, e) => sum + (e.overall_score ?? e.score), 0) /
            evaluations.length
        )
      : null;

  const handleFilter = () => {
    setOffset(0);
    void loadEvaluations();
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 32,
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
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            AI品質レポート
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            AIの接客品質を自動採点し、改善ポイントを提案します
          </p>
        </div>
        <LangSwitcher />
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
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{error}</span>
          <button
            onClick={() => void loadEvaluations()}
            style={{
              padding: "8px 16px",
              minHeight: 36,
              borderRadius: 8,
              border: "1px solid rgba(248,113,113,0.4)",
              background: "rgba(248,113,113,0.1)",
              color: "#fca5a5",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            再試行
          </button>
        </div>
      )}

      {/* Filters */}
      <div
        style={{
          marginBottom: 20,
          padding: "16px 20px",
          borderRadius: 14,
          border: "1px solid #1f2937",
          background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
        }}
      >
        {isSuperAdmin && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600 }}>
              テナント絞り込み
            </label>
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
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600 }}>
            スコア範囲
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              value={minScore}
              onChange={(e) => setMinScore(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="最小"
              min={0}
              max={100}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb",
                fontSize: 14,
                width: 70,
                minHeight: 44,
              }}
            />
            <span style={{ color: "#6b7280", fontSize: 14 }}>—</span>
            <input
              type="number"
              value={maxScore}
              onChange={(e) => setMaxScore(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="最大"
              min={0}
              max={100}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb",
                fontSize: 14,
                width: 70,
                minHeight: 44,
              }}
            />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 12, color: "#9ca3af", fontWeight: 600 }}>
            期間
          </label>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
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
            <option value={7}>7日</option>
            <option value={30}>30日</option>
            <option value={90}>90日</option>
          </select>
        </div>
        <button
          onClick={handleFilter}
          style={{
            padding: "8px 20px",
            minHeight: 44,
            borderRadius: 8,
            border: "1px solid rgba(59,130,246,0.4)",
            background: "rgba(59,130,246,0.12)",
            color: "#60a5fa",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            alignSelf: "flex-end",
          }}
        >
          絞り込む
        </button>
      </div>

      {/* Stats bar */}
      {!loading && evaluations.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 16px",
            borderRadius: 10,
            border: "1px solid #1f2937",
            background: "rgba(15,23,42,0.6)",
            display: "flex",
            gap: 24,
            fontSize: 13,
            color: "#9ca3af",
          }}
        >
          <span>
            平均スコア:{" "}
            <strong style={{ color: "#f9fafb" }}>{avgScore ?? "—"}</strong>
          </span>
          <span>
            件数:{" "}
            <strong style={{ color: "#f9fafb" }}>{total}</strong>
          </span>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込み中...
        </div>
      ) : evaluations.length === 0 ? (
        <div
          style={{
            padding: "48px 24px",
            textAlign: "center",
            color: "#6b7280",
            fontSize: 15,
            borderRadius: 14,
            border: "1px solid #1f2937",
            background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
          }}
        >
          評価データがありません
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {evaluations.map((ev) => {
            const displayScore = ev.overall_score ?? ev.score;
            const isExpanded = expandedId === ev.id;
            const cfg = scoreConfig(displayScore);
            const hasAxisScores =
              ev.psychology_fit_score != null ||
              ev.customer_reaction_score != null ||
              ev.stage_progress_score != null ||
              ev.taboo_violation_score != null;
            return (
              <div
                key={ev.id}
                style={{
                  borderRadius: 14,
                  border: "1px solid #1f2937",
                  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                  overflow: "hidden",
                }}
              >
                {/* Main row */}
                <div
                  style={{
                    padding: "18px 20px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 12,
                    cursor: hasAxisScores ? "pointer" : "default",
                  }}
                  onClick={() => hasAxisScores && setExpandedId(isExpanded ? null : ev.id)}
                >
                  {/* Left */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span
                        style={{
                          padding: "3px 10px",
                          borderRadius: 999,
                          background: "rgba(34,197,94,0.15)",
                          border: "1px solid rgba(34,197,94,0.3)",
                          color: "#4ade80",
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {ev.tenant_id}
                      </span>
                    </div>
                    <span style={{ fontSize: 13, color: "#9ca3af", fontFamily: "monospace" }}>
                      {ev.session_id.slice(0, 16)}
                    </span>
                    <span style={{ fontSize: 12, color: "#6b7280" }}>
                      {formatDate(ev.evaluated_at)}
                    </span>
                  </div>

                  {/* Center */}
                  <div style={{ fontSize: 13, color: "#9ca3af" }}>
                    {ev.judge_model ?? ev.model_used ?? "AI審査員"}
                  </div>

                  {/* Right */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <ScoreBadge score={displayScore} />
                    {hasAxisScores && (
                      <span style={{ color: "#6b7280", fontSize: 12 }}>
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate(`/admin/evaluations/${ev.id}`); }}
                      style={{
                        padding: "8px 16px",
                        minHeight: 44,
                        borderRadius: 8,
                        border: "1px solid #374151",
                        background: "rgba(15,23,42,0.8)",
                        color: "#e5e7eb",
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      詳細→
                    </button>
                  </div>
                </div>

                {/* Expanded: 4-axis breakdown */}
                {isExpanded && hasAxisScores && (
                  <div
                    style={{
                      padding: "16px 20px",
                      borderTop: "1px solid #1f2937",
                      background: "rgba(0,0,0,0.2)",
                    }}
                  >
                    <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 12px 0", fontWeight: 600 }}>
                      4軸スコア内訳
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {AXIS_META.map(({ key, label, weight, tooltip }) => {
                        const axisScore = ev[key] ?? 0;
                        const axisCfg = scoreConfig(axisScore);
                        return (
                          <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span
                              title={tooltip}
                              style={{
                                fontSize: 12,
                                color: "#9ca3af",
                                width: 110,
                                flexShrink: 0,
                                cursor: "help",
                                borderBottom: "1px dotted #4b5563",
                              }}
                            >
                              {label}
                            </span>
                            <div
                              style={{
                                flex: 1,
                                height: 8,
                                borderRadius: 4,
                                background: "rgba(255,255,255,0.06)",
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  width: `${axisScore}%`,
                                  height: "100%",
                                  background: axisCfg.color,
                                  borderRadius: 4,
                                  transition: "width 0.3s ease",
                                }}
                              />
                            </div>
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                color: axisCfg.color,
                                width: 32,
                                textAlign: "right",
                                flexShrink: 0,
                              }}
                            >
                              {axisScore}
                            </span>
                            <span style={{ fontSize: 11, color: "#4b5563", width: 40, flexShrink: 0 }}>
                              ({weight}%)
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {!loading && total > 20 && (
        <div
          style={{
            marginTop: 20,
            display: "flex",
            gap: 12,
            justifyContent: "center",
          }}
        >
          <button
            onClick={() => setOffset((o) => Math.max(0, o - 20))}
            disabled={offset === 0}
            style={{
              padding: "10px 20px",
              minHeight: 44,
              borderRadius: 8,
              border: "1px solid #374151",
              background: offset === 0 ? "rgba(15,23,42,0.4)" : "rgba(15,23,42,0.8)",
              color: offset === 0 ? "#4b5563" : "#e5e7eb",
              fontSize: 14,
              fontWeight: 600,
              cursor: offset === 0 ? "not-allowed" : "pointer",
            }}
          >
            前へ
          </button>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              fontSize: 13,
              color: "#9ca3af",
            }}
          >
            {offset + 1}–{Math.min(offset + 20, total)} / {total}件
          </span>
          <button
            onClick={() => setOffset((o) => o + 20)}
            disabled={offset + 20 >= total}
            style={{
              padding: "10px 20px",
              minHeight: 44,
              borderRadius: 8,
              border: "1px solid #374151",
              background: offset + 20 >= total ? "rgba(15,23,42,0.4)" : "rgba(15,23,42,0.8)",
              color: offset + 20 >= total ? "#4b5563" : "#e5e7eb",
              fontSize: 14,
              fontWeight: 600,
              cursor: offset + 20 >= total ? "not-allowed" : "pointer",
            }}
          >
            次へ
          </button>
        </div>
      )}
    </div>
  );
}
