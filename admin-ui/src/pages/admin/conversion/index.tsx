// admin-ui/src/pages/admin/conversion/index.tsx
// Phase58: コンバージョン最適化ダッシュボード

import { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";
import { useLang } from "../../../i18n/LangContext";

// ------------------------------------------------------------------ //
// Types
// ------------------------------------------------------------------ //
interface ConversionSummary {
  total: number;
  by_type: Record<string, number>;
  by_principle: Record<string, number>;
  avg_temp_score: number;
}

interface EffectivenessRanking {
  principle: string;
  count: number;
  avg_temp_score: number;
}

interface ABExperiment {
  id: number;
  name: string;
  status: 'draft' | 'running' | 'completed' | 'cancelled';
  traffic_split: number;
  min_sample_size: number;
  created_at: string;
}

interface ABVariantResult {
  total: number;
  converted: number;
  conversion_rate: number;
  avg_judge_score: number | null;
}

// ------------------------------------------------------------------ //
// Styles
// ------------------------------------------------------------------ //
const PAGE: CSSProperties = { padding: "80px 24px 48px", maxWidth: 960, margin: "0 auto", color: "#f9fafb", fontFamily: "system-ui, sans-serif" };
const CARD: CSSProperties = { background: "rgba(15,23,42,0.8)", border: "1px solid #1f2937", borderRadius: 12, padding: "20px 24px", marginBottom: 16 };
const GRID4: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14, marginBottom: 24 };
const KPI: CSSProperties = { background: "rgba(15,23,42,0.8)", border: "1px solid #1f2937", borderRadius: 12, padding: "16px 20px" };
const SECTION_TITLE: CSSProperties = { fontSize: 15, fontWeight: 700, color: "#f9fafb", marginBottom: 14 };

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280",
  running: "#22c55e",
  completed: "#3b82f6",
  cancelled: "#ef4444",
};

// ------------------------------------------------------------------ //
// KPI Card
// ------------------------------------------------------------------ //
function KpiCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={KPI}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: "#f9fafb", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ //
// Bar chart (inline SVG-style via divs)
// ------------------------------------------------------------------ //
function BarChart({ items }: { items: { label: string; value: number }[] }) {
  if (items.length === 0) return null;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 120, fontSize: 12, color: "#d1d5db", textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.label}
          </div>
          <div style={{ flex: 1, background: "#1e293b", borderRadius: 4, height: 20, overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.round((item.value / max) * 100)}%`,
                height: "100%",
                background: "linear-gradient(90deg, #3b82f6, #8b5cf6)",
                borderRadius: 4,
                minWidth: 4,
                transition: "width 0.4s",
              }}
            />
          </div>
          <div style={{ width: 32, fontSize: 12, color: "#9ca3af", textAlign: "right", flexShrink: 0 }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ //
// Main
// ------------------------------------------------------------------ //
export default function ConversionDashboardPage() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { isSuperAdmin, user } = useAuth();

  const [summary, setSummary] = useState<ConversionSummary | null>(null);
  const [rankings, setRankings] = useState<EffectivenessRanking[]>([]);
  const [experiments, setExperiments] = useState<ABExperiment[]>([]);
  const [suggestions, setSuggestions] = useState<Array<{ description: string; suggestedAction: string; type: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d');
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const showToast = (msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const tenantParam = !isSuperAdmin && user?.tenantId ? `&tenant_id=${user.tenantId}` : '';

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [attrRes, effRes, expRes] = await Promise.all([
        authFetch(`${API_BASE}/v1/admin/conversion/attributions?period=${period}${tenantParam}`),
        authFetch(`${API_BASE}/v1/admin/conversion/effectiveness?period=${period}${tenantParam}`),
        authFetch(`${API_BASE}/v1/admin/ab/experiments?${isSuperAdmin ? '' : `tenant_id=${user?.tenantId ?? ''}`}`),
      ]);

      if (attrRes.ok) {
        const data = await attrRes.json();
        setSummary(data.summary);
      }
      if (effRes.ok) {
        const data = await effRes.json();
        setRankings(data.rankings ?? []);
      }
      if (expRes.ok) {
        const data = await expRes.json();
        setExperiments(data.experiments ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [period, isSuperAdmin, user?.tenantId, tenantParam]);

  useEffect(() => { void loadData(); }, [loadData]);

  // Load autotuning suggestions from notifications
  useEffect(() => {
    authFetch(`${API_BASE}/v1/admin/notifications?type=auto_tuning_suggestion&unread=true`)
      .then((r) => r.ok ? r.json() : { notifications: [] })
      .then((data) => {
        setSuggestions(
          (data.notifications ?? []).slice(0, 5).map((n: any) => ({
            description: n.message,
            suggestedAction: n.metadata?.suggested_action ?? '',
            type: n.metadata?.candidate_type ?? '',
          }))
        );
      })
      .catch(() => {});
  }, []);

  const topPrinciple = rankings[0]?.principle ?? t("conversion.no_data");
  const chartData = rankings.slice(0, 8).map((r) => ({ label: r.principle, value: r.count }));

  const statusLabel = (status: string): string => {
    const k = `conversion.ab_status_${status}` as any;
    return t(k);
  };

  const handleApplySuggestion = (suggestion: { suggestedAction: string }) => {
    // チューニングルール作成ページへ遷移（提案テキストをクエリに付与）
    navigate(`/admin/tuning?suggestion=${encodeURIComponent(suggestion.suggestedAction)}`);
  };

  return (
    <div style={PAGE}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>📈 {t("conversion.title")}</h1>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          {(['7d', '30d', '90d'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: "6px 14px",
                minHeight: 36,
                borderRadius: 8,
                border: `1px solid ${period === p ? "#3b82f6" : "#374151"}`,
                background: period === p ? "rgba(59,130,246,0.15)" : "none",
                color: period === p ? "#60a5fa" : "#9ca3af",
                fontSize: 13,
                cursor: "pointer",
                fontWeight: period === p ? 700 : 400,
              }}
            >
              {p === '7d' ? '7日' : p === '30d' ? '30日' : '90日'}
            </button>
          ))}
          {loading && <span style={{ fontSize: 12, color: "#6b7280" }}>読み込み中...</span>}
        </div>
      </div>

      {/* KPI Cards */}
      <div style={GRID4}>
        <KpiCard label={t("conversion.total")} value={summary?.total ?? 0} />
        <KpiCard label={t("conversion.avg_temp")} value={summary ? `${summary.avg_temp_score}/100` : '-'} />
        <KpiCard label={t("conversion.top_principle")} value={topPrinciple} />
        <KpiCard label="実施中A/Bテスト" value={experiments.filter((e) => e.status === 'running').length} />
      </div>

      {/* Effectiveness Rankings */}
      <div style={CARD}>
        <div style={SECTION_TITLE}>🧠 {t("conversion.effectiveness")}</div>
        {rankings.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 14 }}>{t("conversion.no_data")}</p>
        ) : (
          <BarChart items={chartData} />
        )}
      </div>

      {/* A/B Tests */}
      <div style={CARD}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={SECTION_TITLE}>🔬 {t("conversion.ab_tests")}</div>
          <button
            onClick={() => navigate('/admin/conversion/ab')}
            style={{ padding: "8px 16px", minHeight: 36, borderRadius: 8, border: "1px solid #3b82f6", background: "none", color: "#60a5fa", fontSize: 13, cursor: "pointer" }}
          >
            管理
          </button>
        </div>
        {experiments.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 14 }}>{t("conversion.no_data")}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {experiments.slice(0, 5).map((exp) => (
              <div key={exp.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#1e293b", borderRadius: 8 }}>
                <span
                  style={{
                    padding: "3px 8px",
                    borderRadius: 999,
                    background: `${STATUS_COLORS[exp.status]}22`,
                    border: `1px solid ${STATUS_COLORS[exp.status]}55`,
                    color: STATUS_COLORS[exp.status],
                    fontSize: 11,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {statusLabel(exp.status)}
                </span>
                <span style={{ flex: 1, fontSize: 14, color: "#e5e7eb" }}>{exp.name}</span>
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  最小サンプル: {exp.min_sample_size}件
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Auto-tuning Suggestions */}
      <div style={CARD}>
        <div style={SECTION_TITLE}>💡 {t("conversion.suggestions")}</div>
        {suggestions.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 14 }}>{t("conversion.no_suggestions")}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {suggestions.map((s, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 14,
                  padding: "14px 16px",
                  background: "rgba(59,130,246,0.06)",
                  border: "1px solid rgba(59,130,246,0.2)",
                  borderRadius: 10,
                }}
              >
                <span style={{ fontSize: 20, flexShrink: 0 }}>
                  {s.type === 'judge_repeated' ? '🔁' : s.type === 'ab_winner' ? '🏆' : '⭐'}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, color: "#e5e7eb", marginBottom: 4 }}>{s.description}</div>
                  {s.suggestedAction && (
                    <div style={{ fontSize: 12, color: "#6b7280" }}>提案: {s.suggestedAction}</div>
                  )}
                </div>
                <button
                  onClick={() => handleApplySuggestion(s)}
                  style={{
                    padding: "8px 14px",
                    minHeight: 44,
                    borderRadius: 8,
                    border: "1px solid #3b82f6",
                    background: "none",
                    color: "#60a5fa",
                    fontSize: 13,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {t("conversion.apply")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 32, right: 24,
          background: toast.type === "success" ? "#16a34a" : "#dc2626",
          color: "#fff", padding: "12px 20px", borderRadius: 10, fontSize: 14, fontWeight: 600,
          zIndex: 3000, boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
