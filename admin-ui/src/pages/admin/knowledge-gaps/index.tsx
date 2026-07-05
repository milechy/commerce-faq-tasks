// admin-ui/src/pages/admin/knowledge-gaps/index.tsx
// GID 1216275179995736: 未回答質問からのワンクリック改善導線

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

interface KnowledgeGap {
  id: number;
  tenant_id: string;
  user_question: string;
  rag_hit_count: number;
  rag_top_score: number;
  created_at: string;
}

export default function KnowledgeGapsPage() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const { user, isSuperAdmin, previewMode, previewTenantId } = useAuth();

  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<number | null>(null);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [selectedTenantFilter, setSelectedTenantFilter] = useState<string>("");

  const locale = lang === "en" ? "en-US" : "ja-JP";
  const ownTenantId = previewMode ? (previewTenantId ?? "") : (user?.tenantId ?? "");
  const effectiveTenant = isSuperAdmin ? selectedTenantFilter : ownTenantId;

  useEffect(() => {
    if (!isSuperAdmin) return;
    authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((r) => r.json())
      .then((data: { tenants?: { id: string; name: string }[] }) => setTenants(data.tenants ?? []))
      .catch(() => {});
  }, [isSuperAdmin]);

  const loadGaps = useCallback(async () => {
    if (isSuperAdmin && !selectedTenantFilter) {
      setGaps([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: "open" });
      if (effectiveTenant) params.set("tenant", effectiveTenant);
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge/gaps?${params}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { gaps: KnowledgeGap[] };
      setGaps(data.gaps ?? []);
      setError(null);
    } catch {
      setError("データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, selectedTenantFilter, effectiveTenant]);

  useEffect(() => {
    void loadGaps();
  }, [loadGaps]);

  const formatRelative = (iso: string) => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "たった今";
    if (mins < 60) return `${mins}分前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}時間前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}日前`;
    return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" });
  };

  const handleCreateFaq = (gap: KnowledgeGap) => {
    const params = new URLSearchParams({
      tab: "text",
      gap_id: String(gap.id),
      question: gap.user_question,
    });
    navigate(`/admin/knowledge/${gap.tenant_id}?${params.toString()}`);
  };

  const handleCreateTuningRule = (gap: KnowledgeGap) => {
    const params = new URLSearchParams({
      create: "1",
      userMsg: gap.user_question,
      assistantMsg: "ご質問の内容に完全に一致するFAQは見つかりませんでした。",
      presetTenantId: gap.tenant_id,
      resolveGapId: String(gap.id),
    });
    navigate(`/admin/tuning?${params.toString()}`);
  };

  const handleDismiss = async (gap: KnowledgeGap) => {
    setDismissingId(gap.id);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge/gaps/${gap.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "dismissed" }),
      });
      if (!res.ok) throw new Error();
      setGaps((prev) => prev.filter((g) => g.id !== gap.id));
    } catch {
      setError("却下に失敗しました");
    } finally {
      setDismissingId(null);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{ background: "none", border: "none", color: "var(--muted-foreground)", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 8, display: "block" }}
          >
            {t("common.back_to_dashboard")}
          </button>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
            🔍 未回答質問
          </h1>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", marginTop: 4, marginBottom: 0 }}>
            AIが十分に答えられなかった質問です。FAQ登録やチューニングルール化でワンクリック改善できます
          </p>
        </div>
        <LangSwitcher />
      </header>

      {isSuperAdmin && (
        <div style={{ marginBottom: 16 }}>
          <select
            value={selectedTenantFilter}
            onChange={(e) => setSelectedTenantFilter(e.target.value)}
            style={{
              padding: "8px 12px", minHeight: 38, borderRadius: 10,
              border: "1px solid var(--border)", background: "var(--card)",
              color: "var(--foreground)", fontSize: 13, cursor: "pointer",
            }}
          >
            <option value="">テナントを選択してください</option>
            {tenants.map((tn) => (
              <option key={tn.id} value={tn.id}>{tn.name}</option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div style={{ marginBottom: 20, padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {isSuperAdmin && !selectedTenantFilter ? (
        <div style={{ padding: "48px 24px", textAlign: "center", borderRadius: 14, border: "1px dashed var(--border)", color: "var(--muted-foreground)" }}>
          テナントを選択してください
        </div>
      ) : loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込んでいます...
        </div>
      ) : gaps.length === 0 ? (
        <div style={{ padding: "48px 24px", textAlign: "center", borderRadius: 14, border: "1px solid var(--border)", background: "var(--card)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <p style={{ color: "var(--foreground)", fontSize: 15, fontWeight: 600, margin: 0 }}>
            未回答の質問はありません
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {gaps.map((gap) => (
            <div
              key={gap.id}
              style={{
                borderRadius: 14,
                border: "1px solid var(--border)",
                background: "var(--card)",
                padding: "18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div>
                <p style={{ fontSize: 15, color: "var(--foreground)", fontWeight: 600, margin: "0 0 6px", lineHeight: 1.5 }}>
                  {gap.user_question}
                </p>
                <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                  🕐 {formatRelative(gap.created_at)}
                  {isSuperAdmin && ` · ${gap.tenant_id}`}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => handleCreateFaq(gap)}
                  style={{
                    padding: "10px 16px", minHeight: 44, borderRadius: 10,
                    border: "none", background: "linear-gradient(135deg, #22c55e, #4ade80)",
                    color: "#022c22", fontSize: 14, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  📚 FAQとして登録
                </button>
                <button
                  onClick={() => handleCreateTuningRule(gap)}
                  style={{
                    padding: "10px 16px", minHeight: 44, borderRadius: 10,
                    border: "1px solid rgba(59,130,246,0.4)", background: "rgba(59,130,246,0.1)",
                    color: "#93c5fd", fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  🎛️ チューニングルールにする
                </button>
                <button
                  onClick={() => void handleDismiss(gap)}
                  disabled={dismissingId === gap.id}
                  style={{
                    marginLeft: "auto",
                    padding: "10px 14px", minHeight: 44, borderRadius: 10,
                    border: "1px solid var(--border)", background: "transparent",
                    color: "var(--muted-foreground)", fontSize: 13, cursor: dismissingId === gap.id ? "default" : "pointer", whiteSpace: "nowrap",
                  }}
                >
                  {dismissingId === gap.id ? "処理中..." : "却下する"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
