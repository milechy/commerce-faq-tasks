import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { API_BASE } from "../../../lib/api";
import KnowledgeFaqEditModal, { type KnowledgeFaqItem } from "../../../components/KnowledgeFaqEditModal";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { useAuth } from "../../../auth/useAuth";
import KnowledgeAttributionTab from "../../../components/knowledge/KnowledgeAttributionTab";
import TextInputTab from "../../../components/knowledge/TextInputTab";
import ScrapeTab from "../../../components/knowledge/UrlScrapeTab";
import PdfUploadTab, { BookUploadsSection } from "../../../components/knowledge/PdfUploadTab";
import {
  getAccessToken,
  fetchWithAuth,
  formatDate,
  CARD_STYLE,
  BTN_DANGER,
} from "../../../components/knowledge/shared";
import { KNOWLEDGE_TENANT_STORAGE_KEY } from "./index";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

interface KnowledgeItem {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  tags: string[] | null;
  is_published?: boolean;
  is_global?: boolean;
  created_at: string;
}

type Tab = "list" | "text" | "scrape" | "pdf" | "attribution";
type DeleteState = "idle" | "confirming" | "deleting" | "success" | "error";

// ─── タブ1: ナレッジ一覧 ────────────────────────────────────────────────────

function KnowledgeListTab({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const locale = lang === "en" ? "en-US" : "ja-JP";

  const CATEGORIES = [
    { value: "inventory", label: t("category.inventory") },
    { value: "campaign", label: t("category.campaign") },
    { value: "coupon", label: t("category.coupon") },
    { value: "store_info", label: t("category.store_info") },
  ];

  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [publishFilter, setPublishFilter] = useState<"all" | "published" | "draft">("all");
  const [globalFilter, setGlobalFilter] = useState<"all" | "global" | "tenant">("all");
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    question: string;
    state: DeleteState;
    error?: string;
  } | null>(null);
  const [editTarget, setEditTarget] = useState<KnowledgeFaqItem | null>(null);
  const [createMode, setCreateMode] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleModalSuccess = (msg: string) => {
    setEditTarget(null);
    setCreateMode(false);
    showToast(msg);
    void fetchItems();
  };

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ tenant: tenantId });
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (publishFilter === "published") params.set("is_published", "true");
      if (publishFilter === "draft") params.set("is_published", "false");
      if (globalFilter === "global") params.set("is_global", "true");
      if (globalFilter === "tenant") params.set("is_global", "false");

      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge?${params}`);
      if (!res.ok) throw new Error(t("knowledge.load_error"));
      const data = (await res.json()) as { items: KnowledgeItem[] };
      setItems(data.items ?? []);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setLoading(false);
    }
  }, [navigate, tenantId, categoryFilter, publishFilter, globalFilter, t]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleteTarget((prev) => prev ? { ...prev, state: "deleting" } : null);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/${deleteTarget.id}?tenant=${tenantId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(t("knowledge.delete_error"));
      setDeleteTarget((prev) => prev ? { ...prev, state: "success" } : null);
      setItems((prev) => prev.filter((i) => i.id !== deleteTarget.id));
      setTimeout(() => setDeleteTarget(null), 2000);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setDeleteTarget((prev) =>
        prev ? { ...prev, state: "error", error: err instanceof Error ? err.message : t("knowledge.delete_error") } : null
      );
    }
  };

  const handleTogglePublish = async (item: KnowledgeItem) => {
    setTogglingId(item.id);
    try {
      const newState = !item.is_published;
      await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/faq/${item.id}?tenant=${tenantId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: item.question,
            answer: item.answer,
            category: item.category ?? undefined,
            tags: item.tags ?? [],
            is_published: newState,
          }),
        }
      );
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, is_published: newState } : i))
      );
    } catch {
      // no-op
    } finally {
      setTogglingId(null);
    }
  };

  const categoryLabel = (cat: string | null) => {
    const found = CATEGORIES.find((c) => c.value === cat);
    return found ? found.label : cat ?? t("knowledge.uncategorized");
  };

  return (
    <div>
      {/* 新規追加ボタン */}
      <button
        onClick={() => setCreateMode(true)}
        style={{
          width: "100%",
          padding: "18px 24px",
          minHeight: 60,
          borderRadius: 14,
          border: "none",
          background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: "#022c22",
          fontSize: 18,
          fontWeight: 700,
          cursor: "pointer",
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          boxShadow: "0 8px 24px rgba(34,197,94,0.25)",
        }}
      >
        <span style={{ fontSize: 22 }}>＋</span>
        {t("knowledge.add_faq")}
      </button>

      {/* フィルター */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 14, color: "#9ca3af" }}>{t("knowledge.category_filter")}</span>
        {[{ value: "all", label: t("knowledge.all") }, ...CATEGORIES].map((c) => (
          <button
            key={c.value}
            onClick={() => setCategoryFilter(c.value)}
            style={{
              padding: "6px 14px",
              minHeight: 36,
              borderRadius: 999,
              border: `1px solid ${categoryFilter === c.value ? "#22c55e" : "#374151"}`,
              background: categoryFilter === c.value ? "rgba(34,197,94,0.15)" : "transparent",
              color: categoryFilter === c.value ? "#4ade80" : "#9ca3af",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {c.label}
          </button>
        ))}
        <button
          onClick={fetchItems}
          disabled={loading}
          style={{
            marginLeft: "auto",
            padding: "6px 14px",
            minHeight: 36,
            borderRadius: 999,
            border: "1px solid #374151",
            background: "transparent",
            color: "#9ca3af",
            fontSize: 13,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? t("knowledge.refreshing") : t("common.refresh")}
        </button>
      </div>
      {/* 公開状態フィルター */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
        {(["all", "published", "draft"] as const).map((v) => {
          const label = v === "all" ? (lang === "en" ? "All" : "すべて") : v === "published" ? (lang === "en" ? "Published" : "公開中") : (lang === "en" ? "Draft" : "非公開");
          const active = publishFilter === v;
          return (
            <button
              key={v}
              onClick={() => setPublishFilter(v)}
              style={{
                padding: "4px 12px",
                minHeight: 32,
                borderRadius: 999,
                border: `1px solid ${active ? "#3b82f6" : "#374151"}`,
                background: active ? "rgba(59,130,246,0.15)" : "transparent",
                color: active ? "#93c5fd" : "#6b7280",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      {/* グローバルナレッジフィルター */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, alignItems: "center" }}>
        {([
          { v: "all", label: "全て" },
          { v: "tenant", label: "テナント別" },
          { v: "global", label: "⭐ グローバルのみ" },
        ] as const).map(({ v, label }) => {
          const active = globalFilter === v;
          return (
            <button
              key={v}
              onClick={() => setGlobalFilter(v)}
              style={{
                padding: "4px 12px",
                minHeight: 32,
                borderRadius: 999,
                border: `1px solid ${active ? "rgba(234,179,8,0.5)" : "#374151"}`,
                background: active ? "rgba(234,179,8,0.1)" : "transparent",
                color: active ? "#fbbf24" : "#6b7280",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          {t("knowledge.loading")}
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", borderRadius: 14, border: "1px dashed #374151", background: "rgba(15,23,42,0.4)" }}>
          <span style={{ display: "block", fontSize: 40, marginBottom: 12 }}>📭</span>
          <p style={{ fontSize: 16, fontWeight: 600, color: "#d1d5db", margin: 0 }}>
            {t("knowledge.empty_title")}
          </p>
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 6, marginBottom: 0 }}>
            {t("knowledge.empty_sub")}
          </p>
        </div>
      ) : (
        <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 18px", borderBottom: "1px solid #111827", fontSize: 13, color: "#6b7280" }}>
            {t("knowledge.count", { n: items.length })}
          </div>
          {items.map((item, idx) => (
            <div
              key={item.id}
              style={{
                padding: "16px 18px",
                borderBottom: idx === items.length - 1 ? "none" : "1px solid #111827",
                display: "flex",
                gap: 14,
                alignItems: "flex-start",
                flexWrap: "wrap",
                opacity: item.is_published === false ? 0.55 : 1,
                transition: "opacity 0.2s",
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                  <span style={{
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(34,197,94,0.1)",
                    border: "1px solid rgba(34,197,94,0.2)",
                    color: "#4ade80",
                    fontSize: 11,
                    fontWeight: 600,
                  }}>
                    {categoryLabel(item.category)}
                  </span>
                  <span style={{
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: item.is_published === false ? "rgba(75,85,99,0.3)" : "rgba(34,197,94,0.08)",
                    border: `1px solid ${item.is_published === false ? "#4b5563" : "rgba(34,197,94,0.2)"}`,
                    color: item.is_published === false ? "#6b7280" : "#86efac",
                    fontSize: 11,
                    fontWeight: 600,
                  }}>
                    {item.is_published === false
                      ? (lang === "en" ? "⏸️ Draft" : "⏸️ 非公開")
                      : (lang === "en" ? "✅ Published" : "✅ 公開中")}
                  </span>
                  {item.is_global && (
                    <span style={{
                      padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
                      background: "rgba(234,179,8,0.12)", border: "1px solid rgba(234,179,8,0.3)", color: "#fbbf24",
                    }}>
                      ⭐ グローバル
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: "#6b7280" }}>{formatDate(item.created_at, locale)}</span>
                </div>
                <p style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", margin: "0 0 4px", lineHeight: 1.4 }}>
                  Q: {item.question}
                </p>
                <p style={{ fontSize: 13, color: "#9ca3af", margin: 0, lineHeight: 1.5 }}>
                  A: {item.answer.slice(0, 120)}{item.answer.length > 120 ? "…" : ""}
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  onClick={() => handleTogglePublish(item)}
                  disabled={togglingId === item.id}
                  style={{
                    padding: "10px 14px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: `1px solid ${item.is_published === false ? "rgba(34,197,94,0.4)" : "#4b5563"}`,
                    background: item.is_published === false ? "rgba(34,197,94,0.1)" : "rgba(75,85,99,0.15)",
                    color: item.is_published === false ? "#4ade80" : "#9ca3af",
                    fontSize: 13,
                    cursor: togglingId === item.id ? "default" : "pointer",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    opacity: togglingId === item.id ? 0.6 : 1,
                  }}
                >
                  {item.is_published === false
                    ? (lang === "en" ? "Publish" : "公開する")
                    : (lang === "en" ? "Unpublish" : "非公開にする")}
                </button>
                <button
                  onClick={() =>
                    setEditTarget({
                      id: item.id,
                      question: item.question,
                      answer: item.answer,
                      category: item.category,
                      tags: item.tags,
                      is_published: item.is_published,
                    })
                  }
                  style={{
                    padding: "10px 16px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid #1d4ed8",
                    background: "rgba(29,78,216,0.15)",
                    color: "#93c5fd",
                    fontSize: 14,
                    cursor: "pointer",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("knowledge.edit")}
                </button>
                <button
                  onClick={() => setDeleteTarget({ id: item.id, question: item.question, state: "confirming" })}
                  style={BTN_DANGER}
                >
                  {t("knowledge.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editTarget && (
        <KnowledgeFaqEditModal
          mode="edit"
          tenantId={tenantId}
          item={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={handleModalSuccess}
        />
      )}

      {createMode && (
        <KnowledgeFaqEditModal
          mode="create"
          tenantId={tenantId}
          onClose={() => setCreateMode(false)}
          onSuccess={handleModalSuccess}
        />
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            padding: "16px 28px",
            borderRadius: 12,
            background: "rgba(5,46,22,0.95)",
            border: "1px solid rgba(74,222,128,0.4)",
            color: "#86efac",
            fontSize: 16,
            fontWeight: 600,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap",
          }}
        >
          {toast}
        </div>
      )}

      {deleteTarget && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}
          onClick={(e) => { if (e.target === e.currentTarget && deleteTarget.state !== "deleting") setDeleteTarget(null); }}
        >
          <div style={{ background: "#0f172a", border: "1px solid #1f2937", borderRadius: 16, padding: "28px 24px", maxWidth: 420, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,0.6)" }}>
            {deleteTarget.state === "success" ? (
              <div style={{ textAlign: "center" }}>
                <span style={{ fontSize: 48, display: "block", marginBottom: 12 }}>✅</span>
                <p style={{ fontSize: 17, fontWeight: 600, color: "#4ade80", margin: 0 }}>{t("knowledge.deleted")}</p>
              </div>
            ) : (
              <>
                <h3 style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>{t("knowledge.delete_confirm_title")}</h3>
                <p style={{ fontSize: 14, color: "#d1d5db", margin: "0 0 6px" }}>Q: {deleteTarget.question}</p>
                <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 20px", lineHeight: 1.6 }}>
                  {t("knowledge.delete_confirm_body")}
                </p>
                {deleteTarget.state === "error" && deleteTarget.error && (
                  <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: "rgba(127,29,29,0.4)", color: "#fca5a5", fontSize: 14 }}>
                    {deleteTarget.error}
                  </div>
                )}
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={() => setDeleteTarget(null)}
                    disabled={deleteTarget.state === "deleting"}
                    style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 10, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
                  >
                    {t("knowledge.cancel_delete")}
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleteTarget.state === "deleting"}
                    style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 10, border: "none", background: "linear-gradient(135deg, #991b1b, #dc2626)", color: "#fee2e2", fontSize: 15, fontWeight: 700, cursor: deleteTarget.state === "deleting" ? "not-allowed" : "pointer" }}
                  >
                    {deleteTarget.state === "deleting" ? t("common.deleting") : t("knowledge.confirm_delete")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

export default function TenantKnowledgePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLang();
  const { tenantId } = useParams<{ tenantId: string }>();
  const { user, isSuperAdmin } = useAuth();

  const searchParams = new URLSearchParams(location.search);
  const tabParam = searchParams.get("tab") as Tab | null;
  const gapId = searchParams.get("gap_id") ? Number(searchParams.get("gap_id")) : undefined;
  const gapQuestion = searchParams.get("question") ?? undefined;

  const [activeTab, setActiveTab] = useState<Tab>(
    tabParam === "text" ||
      tabParam === "scrape" ||
      tabParam === "pdf" ||
      tabParam === "attribution"
      ? tabParam
      : "list"
  );

  // テナント一覧（Super Admin のみ使用）
  const [tenants, setTenants] = useState<Tenant[]>([]);
  useEffect(() => {
    if (!isSuperAdmin) return;
    fetchWithAuth(`${API_BASE}/v1/admin/tenants`)
      .then((res) => res.json() as Promise<{ tenants?: Tenant[]; items?: Tenant[] }>)
      .then((data) => setTenants(data.tenants ?? data.items ?? []))
      .catch(() => {/* best-effort */});
  }, [isSuperAdmin]);

  // tenantId の解決: URL params → pathnameの末尾 → JWTのtenantId
  // /admin/knowledge/global のように固定パスの場合 useParams では undefined になるため
  // pathname から取得するフォールバックを追加
  const pathTenantId = tenantId ?? location.pathname.split("/").pop() ?? "";
  const resolvedTenantId = pathTenantId || user?.tenantId || "";

  // テナント切り替え時に localStorage に保存
  useEffect(() => {
    if (isSuperAdmin && resolvedTenantId) {
      localStorage.setItem(KNOWLEDGE_TENANT_STORAGE_KEY, resolvedTenantId);
    }
  }, [isSuperAdmin, resolvedTenantId]);

  useEffect(() => {
    void (async () => {
      const token = await getAccessToken();
      if (!token) navigate("/login", { replace: true });
    })();
  }, [navigate]);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "list", label: t("knowledge.tab_list"), icon: "📋" },
    { id: "text", label: t("knowledge.tab_text"), icon: "✏️" },
    { id: "scrape", label: t("knowledge.tab_scrape"), icon: "🌐" },
    { id: "pdf", label: "PDFアップロード", icon: "📚" },
    { id: "attribution", label: "CV影響度", icon: "📈" },
  ];

  const isGlobalTenant = resolvedTenantId === "global";

  const handleTenantChange = (newTenantId: string) => {
    localStorage.setItem(KNOWLEDGE_TENANT_STORAGE_KEY, newTenantId);
    const tabSuffix = activeTab !== "list" ? `?tab=${activeTab}` : "";
    navigate(`/admin/knowledge/${newTenantId}${tabSuffix}`);
  };

  const testUrl = isGlobalTenant
    ? "/admin/chat-test?scope=global"
    : `/admin/chat-test?tenantId=${encodeURIComponent(resolvedTenantId)}`;

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
      <header style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
          <button
            onClick={() => navigate("/admin")}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "8px 14px", minHeight: 44, borderRadius: 999, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 14, cursor: "pointer", fontWeight: 500 }}
          >
            {t("nav.back_dashboard")}
          </button>
          <LangSwitcher />
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
          {t("knowledge.title")}
        </h1>
        {isSuperAdmin ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <select
              value={resolvedTenantId}
              onChange={(e) => handleTenantChange(e.target.value)}
              style={{
                flex: 1, padding: "10px 12px", minHeight: 44, borderRadius: 10,
                border: "1px solid #374151", background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb", fontSize: 15, cursor: "pointer",
              }}
            >
              <option value="global">🌐 グローバルナレッジ</option>
              {tenants.map((tn) => (
                <option key={tn.id} value={tn.id}>{tn.name}</option>
              ))}
            </select>
            <button
              onClick={() => navigate(testUrl)}
              style={{
                padding: "10px 16px", minHeight: 44, borderRadius: 10,
                border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.08)",
                color: "#93c5fd", fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              💬 テスト
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button
              onClick={() => navigate(testUrl)}
              style={{
                padding: "10px 16px", minHeight: 44, borderRadius: 10,
                border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.08)",
                color: "#93c5fd", fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}
            >
              💬 テスト
            </button>
          </div>
        )}
      </header>

      {/* タブ */}
      <div style={{ display: "flex", gap: 0, marginBottom: 24, borderBottom: "1px solid #1f2937" }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "12px 20px",
              minHeight: 48,
              border: "none",
              borderBottom: `2px solid ${activeTab === tab.id ? "#22c55e" : "transparent"}`,
              background: "transparent",
              color: activeTab === tab.id ? "#4ade80" : "#9ca3af",
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 700 : 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              transition: "color 0.15s",
            }}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* タブコンテンツ */}
      {activeTab === "list" && (
        <>
          <KnowledgeListTab tenantId={resolvedTenantId} />
          {isGlobalTenant && <BookUploadsSection tenantId={resolvedTenantId} />}
        </>
      )}
      {activeTab === "text" && <TextInputTab tenantId={resolvedTenantId} gapQuestion={gapQuestion} gapId={gapId} />}
      {activeTab === "scrape" && <ScrapeTab tenantId={resolvedTenantId} onCommitSuccess={() => setActiveTab("list")} gapQuestion={gapQuestion} gapId={gapId} />}
      {activeTab === "pdf" && <PdfUploadTab tenantId={resolvedTenantId} />}
      {activeTab === "attribution" && (
        <KnowledgeAttributionTab tenantId={resolvedTenantId} />
      )}
    </div>
  );
}
