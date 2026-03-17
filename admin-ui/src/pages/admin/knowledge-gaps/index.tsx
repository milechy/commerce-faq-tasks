// admin-ui/src/pages/admin/knowledge-gaps/index.tsx
// Phase38+: ナレッジギャップ管理ページ

import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

interface KnowledgeGap {
  id: number;
  tenant_id: string;
  user_question: string;
  session_id: string | null;
  message_id: number | null;
  rag_hit_count: number;
  rag_top_score: number;
  status: "open" | "resolved" | "dismissed";
  created_at: string;
}

interface TenantOption {
  id: string;
  name: string;
  slug: string;
}

type StatusFilter = "open" | "resolved" | "dismissed";

export default function KnowledgeGapsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang } = useLang();
  const { user, isSuperAdmin } = useAuth();

  // allGaps: テナントフィルターなしの全ギャップ（Super Admin用）
  // clientGaps: Client Admin用（サーバー側テナント絞り込み済み）
  const [allGaps, setAllGaps] = useState<KnowledgeGap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [dismissingId, setDismissingId] = useState<number | null>(null);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string>("");

  const locale = lang === "en" ? "en-US" : "ja-JP";
  const tenantId = isSuperAdmin ? undefined : (user?.tenantId ?? undefined);

  // クエリパラメータからテナント初期値を取得（super_admin）
  const queryTenant = new URLSearchParams(location.search).get("tenant") ?? "";

  // Super Admin用: テナント名一覧を取得（名前解決のみに使用）
  useEffect(() => {
    if (!isSuperAdmin) return;
    authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((res) => res.ok ? res.json() as Promise<{ tenants?: TenantOption[]; items?: TenantOption[] }> : Promise.reject())
      .then((data) => setTenants(data.tenants ?? data.items ?? []))
      .catch(() => {/* テナント取得失敗は無視 */});
  }, [isSuperAdmin]);

  // クエリパラメータで初期テナントを設定
  useEffect(() => {
    if (queryTenant) setSelectedTenant(queryTenant);
  }, [queryTenant]);

  const fetchGaps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status: statusFilter, limit: "200" });
      // Super Admin: テナントフィルターなしで全取得 → クライアント側で絞り込む
      // Client Admin: サーバー側でテナント絞り込み
      if (!isSuperAdmin && tenantId) params.set("tenant", tenantId);
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge/gaps?${params}`);
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json() as { gaps: KnowledgeGap[]; total: number };
      setAllGaps(data.gaps);
    } catch {
      setError(t("knowledge_gap.load_error"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, isSuperAdmin, tenantId, t]);

  // Super Admin: allGapsからギャップが存在するテナントのみ抽出
  const tenantsWithGaps = useMemo(() => {
    if (!isSuperAdmin) return [];
    const ids = [...new Set(allGaps.map((g) => g.tenant_id))];
    return ids.map((id) => {
      const found = tenants.find((t) => t.id === id);
      return { id, name: found?.name ?? "", slug: found?.slug ?? id };
    }).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }, [allGaps, tenants, isSuperAdmin]);

  // 表示用ギャップ: Super Adminはクライアント側でテナント絞り込み
  const gaps = useMemo(() => {
    if (!isSuperAdmin || !selectedTenant) return allGaps;
    return allGaps.filter((g) => g.tenant_id === selectedTenant);
  }, [allGaps, selectedTenant, isSuperAdmin]);

  const total = gaps.length;

  useEffect(() => {
    void fetchGaps();
  }, [fetchGaps]);

  const handleDismiss = async (id: number) => {
    setDismissingId(id);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge/gaps/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      });
      if (!res.ok) throw new Error("dismiss failed");
      setAllGaps((prev) => prev.filter((g) => g.id !== id));
    } catch {
      alert(t("knowledge_gap.dismiss_error"));
    } finally {
      setDismissingId(null);
    }
  };

  const handleAddText = (gap: KnowledgeGap) => {
    const tenantPath = `/${gap.tenant_id}`;
    const params = new URLSearchParams({
      tab: "text",
      gap_id: String(gap.id),
      question: gap.user_question,
    });
    navigate(`/admin/knowledge${tenantPath}?${params}`);
  };

  const handleAddUrl = (gap: KnowledgeGap) => {
    const tenantPath = `/${gap.tenant_id}`;
    const params = new URLSearchParams({
      tab: "scrape",
      gap_id: String(gap.id),
      question: gap.user_question,
    });
    navigate(`/admin/knowledge${tenantPath}?${params}`);
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const tenantName = (id: string) => {
    const found = tenants.find((ten) => ten.id === id);
    return found?.name ?? id;
  };

  const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";
  const SELECT_STYLE: React.CSSProperties = {
    padding: "10px 14px",
    minHeight: 40,
    borderRadius: 10,
    border: "1px solid #374151",
    background: "rgba(15,23,42,0.8)",
    color: "#e5e7eb",
    fontSize: 13,
    cursor: "pointer",
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 8, display: "block" }}
          >
            {t("knowledge_gap.back")}
          </button>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            {t("knowledge_gap.title")}
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            {t("knowledge_gap.subtitle")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <LangSwitcher />
          <button
            onClick={() => void fetchGaps()}
            style={{ padding: "10px 16px", minHeight: 44, borderRadius: 10, border: "1px solid #374151", background: "rgba(15,23,42,0.8)", color: "#9ca3af", fontSize: 13, cursor: "pointer" }}
          >
            {t("common.refresh")}
          </button>
        </div>
      </header>

      {/* Filters row */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        {/* Status filter tabs */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["open", "resolved", "dismissed"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                padding: "8px 16px",
                minHeight: 36,
                borderRadius: 999,
                border: `1px solid ${statusFilter === s ? "rgba(234,179,8,0.5)" : "#374151"}`,
                background: statusFilter === s ? "rgba(234,179,8,0.12)" : "rgba(15,23,42,0.8)",
                color: statusFilter === s ? "#fbbf24" : "#9ca3af",
                fontSize: 13,
                fontWeight: statusFilter === s ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {s === "open" ? t("knowledge_gap.status_open")
                : s === "resolved" ? t("knowledge_gap.resolved")
                : t("knowledge_gap.dismissed")}
              {s === statusFilter && total > 0 && (
                <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 999, background: "rgba(234,179,8,0.25)", fontSize: 11, fontWeight: 700 }}>
                  {total}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tenant filter — Super Admin only */}
        {isSuperAdmin && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            <span style={{ fontSize: 13, color: "#9ca3af", whiteSpace: "nowrap" }}>
              {t("knowledge_gap.filter_tenant")}:
            </span>
            <select
              value={selectedTenant}
              onChange={(e) => setSelectedTenant(e.target.value)}
              style={SELECT_STYLE}
            >
              <option value="">{t("knowledge_gap.all_tenants")}</option>
              {tenantsWithGaps.map((ten) => (
                <option key={ten.id} value={ten.id}>{ten.name || ten.slug || ten.id}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ marginBottom: 20, padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span>{error}</span>
          <button onClick={() => void fetchGaps()} style={{ padding: "8px 14px", minHeight: 36, borderRadius: 8, border: "1px solid rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.1)", color: "#fca5a5", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          {t("knowledge_gap.loading")}
        </div>
      ) : gaps.length === 0 ? (
        <div style={{ padding: "48px 24px", textAlign: "center", color: "#6b7280", fontSize: 15, borderRadius: 14, border: "1px solid #1f2937", background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))" }}>
          <span style={{ display: "block", fontSize: 40, marginBottom: 12 }}>✅</span>
          {t("knowledge_gap.no_gaps")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {gaps.map((gap) => (
            <div
              key={gap.id}
              style={{
                borderRadius: 14,
                border: "1px solid #1f2937",
                background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                padding: "18px 20px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
              }}
            >
              {/* Tenant badge — super_admin: 目立つサイズで表示 */}
              {isSuperAdmin && (
                <div style={{ marginBottom: 10 }}>
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 12px",
                    borderRadius: 999,
                    background: "rgba(34,197,94,0.15)",
                    border: "1px solid rgba(34,197,94,0.4)",
                    color: "#4ade80",
                    fontSize: 13,
                    fontWeight: 700,
                  }}>
                    🏢 {tenantName(gap.tenant_id)}
                    <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 11 }}>
                      ({gap.tenant_id})
                    </span>
                  </span>
                </div>
              )}

              {/* Question + metadata row */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Question text */}
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#f9fafb", lineHeight: 1.5, wordBreak: "break-word" }}>
                    「{gap.user_question}」
                  </p>
                  {/* Meta */}
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
                    <span style={{ fontSize: 12, color: "#6b7280" }}>
                      🕐 {formatDate(gap.created_at)}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: gap.rag_hit_count === 0 ? "#f87171" : "#fbbf24",
                        fontWeight: 600,
                      }}
                    >
                      {t("knowledge_gap.rag_hits")}: {gap.rag_hit_count}件
                    </span>
                    {gap.rag_top_score > 0 && (
                      <span style={{ fontSize: 12, color: "#6b7280" }}>
                        top score: {gap.rag_top_score.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              {statusFilter === "open" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    onClick={() => handleAddText(gap)}
                    style={{
                      padding: "9px 16px",
                      minHeight: 44,
                      borderRadius: 10,
                      border: "1px solid rgba(34,197,94,0.4)",
                      background: "rgba(34,197,94,0.1)",
                      color: "#4ade80",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("knowledge_gap.add_text")}
                  </button>

                  <button
                    onClick={() => handleAddUrl(gap)}
                    style={{
                      padding: "9px 16px",
                      minHeight: 44,
                      borderRadius: 10,
                      border: "1px solid rgba(99,102,241,0.4)",
                      background: "rgba(99,102,241,0.1)",
                      color: "#818cf8",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("knowledge_gap.add_url")}
                  </button>

                  <button
                    onClick={() => void handleDismiss(gap.id)}
                    disabled={dismissingId === gap.id}
                    style={{
                      padding: "9px 16px",
                      minHeight: 44,
                      borderRadius: 10,
                      border: "1px solid #374151",
                      background: "rgba(15,23,42,0.8)",
                      color: dismissingId === gap.id ? "#6b7280" : "#9ca3af",
                      fontSize: 13,
                      cursor: dismissingId === gap.id ? "not-allowed" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {dismissingId === gap.id ? "..." : t("knowledge_gap.dismiss")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
