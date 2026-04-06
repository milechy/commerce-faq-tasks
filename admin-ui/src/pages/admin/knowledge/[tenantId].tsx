import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { API_BASE } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";
import KnowledgeFaqEditModal, { type KnowledgeFaqItem } from "../../../components/KnowledgeFaqEditModal";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { useAuth } from "../../../auth/useAuth";
import BookChunksPanel from "./BookChunksPanel";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

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

interface FaqEntry {
  question: string;
  answer: string;
  category?: string;
  duplicate?: {
    existingQuestion: string;
    existingAnswer: string;
  } | null;
}

// カテゴリラベルマップ（未知のカテゴリはキーをそのまま表示）
const CATEGORY_LABELS: Record<string, { ja: string; en: string }> = {
  product_info: { ja: "商品・サービス", en: "Product/Service" },
  pricing: { ja: "料金・価格", en: "Pricing" },
  store_info: { ja: "店舗情報", en: "Store Info" },
  campaign: { ja: "キャンペーン", en: "Campaign" },
  inventory: { ja: "在庫・車両", en: "Inventory" },
  coupon: { ja: "クーポン", en: "Coupon" },
  booking: { ja: "予約・申し込み", en: "Booking" },
  warranty: { ja: "保証・サポート", en: "Warranty" },
  general: { ja: "一般", en: "General" },
};

interface ScrapePreviewItem {
  url: string;
  faqs: FaqEntry[];
  error?: string;
}

type Tab = "list" | "text" | "scrape" | "pdf";
type DeleteState = "idle" | "confirming" | "deleting" | "success" | "error";
type Category = string;

// ─── ユーティリティ ───────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) return null;
  return data.session.access_token;
}

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  let token = await getAccessToken();
  if (!token) {
    const { data } = await supabase.auth.refreshSession();
    token = data.session?.access_token ?? null;
  }
  if (!token) throw new Error("__AUTH_REQUIRED__");

  const makeRequest = (t: string) =>
    fetch(url, {
      ...options,
      headers: {
        ...(options.headers as Record<string, string>),
        Authorization: `Bearer ${t}`,
      },
    });

  const res = await makeRequest(token);

  if (res.status === 401 || res.status === 403) {
    const { data } = await supabase.auth.refreshSession();
    const refreshedToken = data.session?.access_token ?? null;
    if (!refreshedToken) throw new Error("__AUTH_REQUIRED__");
    return makeRequest(refreshedToken);
  }

  return res;
}

/** ナレッジギャップを「解決済み」に更新する（fire-and-forget 向け） */
async function resolveKnowledgeGap(gapId: number): Promise<void> {
  await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/gaps/${gapId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolved" }),
  });
}

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: "16px 24px",
  minHeight: 56,
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
  color: "#022c22",
  fontSize: 17,
  fontWeight: 700,
  cursor: "pointer",
  width: "100%",
};

const BTN_DANGER: React.CSSProperties = {
  padding: "10px 16px",
  minHeight: 44,
  borderRadius: 10,
  border: "1px solid #7f1d1d",
  background: "rgba(127,29,29,0.2)",
  color: "#fca5a5",
  fontSize: 14,
  cursor: "pointer",
  fontWeight: 500,
};

const TEXTAREA_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: 180,
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  fontFamily: "inherit",
  resize: "vertical",
  boxSizing: "border-box",
};

const SELECT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  minHeight: 48,
};

// ─── ナレッジギャップバナー ────────────────────────────────────────────────────

function GapQuestionBanner({ question }: { question: string }) {
  return (
    <div
      style={{
        padding: "14px 18px",
        borderRadius: 12,
        border: "1px solid rgba(234,179,8,0.4)",
        background: "rgba(120,53,15,0.25)",
        marginBottom: 4,
      }}
    >
      <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 700, color: "#fbbf24" }}>
        ❓ ユーザーの質問
      </p>
      <p style={{ margin: "0 0 6px", fontSize: 15, color: "#f9fafb", fontWeight: 600, lineHeight: 1.5 }}>
        「{question}」
      </p>
      <p style={{ margin: 0, fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
        この質問に回答できる情報をナレッジに追加してください。登録後、未回答の質問が自動的に解決済みになります。
      </p>
    </div>
  );
}

// ─── グローバルナレッジチェックボックス（Super Admin専用） ────────────────────

function GlobalKnowledgeCheckbox({
  isGlobal,
  onChange,
  disabled = false,
}: {
  isGlobal: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useLang();
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        cursor: disabled ? "default" : "pointer",
        padding: "12px 14px",
        borderRadius: 10,
        border: `1px solid ${isGlobal ? "rgba(234,179,8,0.4)" : "#374151"}`,
        background: isGlobal ? "rgba(234,179,8,0.08)" : "rgba(0,0,0,0.2)",
        marginBottom: 16,
        fontSize: 14,
        color: isGlobal ? "#fbbf24" : "#9ca3af",
        fontWeight: isGlobal ? 600 : 400,
        transition: "all 0.15s",
        userSelect: "none",
        opacity: disabled ? 0.85 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={isGlobal}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        style={{ width: 18, height: 18, accentColor: "#fbbf24", cursor: disabled ? "default" : "pointer" }}
      />
      📚 {t("knowledge.global_label")}
    </label>
  );
}

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

// ─── タブ2: テキスト入力（LLM自動FAQ化） ────────────────────────────────────

function TextInputTab({
  tenantId,
  gapQuestion,
  gapId,
}: {
  tenantId: string;
  gapQuestion?: string;
  gapId?: number;
}) {
  const navigate = useNavigate();
  const { t } = useLang();
  const { isSuperAdmin } = useAuth();

  const CATEGORIES = [
    { value: "", label: t("knowledge.category_auto") },
    { value: "inventory", label: t("category.inventory") },
    { value: "campaign", label: t("category.campaign") },
    { value: "coupon", label: t("category.coupon") },
    { value: "store_info", label: t("category.store_info") },
    { value: "product_info", label: t("category.product_info") },
    { value: "pricing", label: t("category.pricing") },
    { value: "booking", label: t("category.booking") },
    { value: "warranty", label: t("category.warranty") },
    { value: "general", label: t("category.general") },
  ];

  const [text, setText] = useState("");
  const [category, setCategory] = useState<Category>("");
  const [isGlobal, setIsGlobal] = useState(tenantId === "global");
  useEffect(() => { setIsGlobal(tenantId === "global"); }, [tenantId]);
  const [converting, setConverting] = useState(false);
  const [preview, setPreview] = useState<FaqEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editCategory, setEditCategory] = useState<string>("");

  const handleStartEdit = (idx: number, faq: FaqEntry) => {
    setEditingIndex(idx);
    setEditQuestion(faq.question);
    setEditAnswer(faq.answer);
    setEditCategory(faq.category ?? "");
  };
  const handleSaveEdit = () => {
    if (editingIndex === null || !preview) return;
    const updated = preview.map((f, i) =>
      i === editingIndex ? { ...f, question: editQuestion.trim(), answer: editAnswer.trim(), category: editCategory || undefined } : f
    );
    setPreview(updated);
    setEditingIndex(null);
  };
  const handleDeleteFaq = (idx: number) => {
    if (!preview) return;
    setPreview(preview.filter((_, i) => i !== idx));
  };

  const handleConvert = async () => {
    if (text.trim().length < 50) {
      setError(t("knowledge.text_min_error"));
      return;
    }

    setConverting(true);
    setError(null);
    setPreview(null);
    setSuccess(null);

    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/text?tenant=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), ...(category ? { category } : {}), ...(isGlobal ? { target: "global" } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean; preview?: FaqEntry[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("knowledge.load_error"));
      setPreview(data.preview ?? []);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setConverting(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.length === 0) return;

    setCommitting(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/text/commit?tenant=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faqs: preview, ...(category ? { category } : {}), ...(isGlobal ? { target: "global" } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean; inserted?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("knowledge.load_error"));
      // ギャップが紐付いていれば自動解決
      if (gapId) {
        await resolveKnowledgeGap(gapId).catch(() => {/* silent */});
        setSuccess("✅ ナレッジを追加し、未回答の質問を解決済みにしました");
      } else {
        setSuccess(t("knowledge.committed", { n: data.inserted ?? 0 }));
      }
      setPreview(null);
      setText("");
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {gapQuestion && <GapQuestionBanner question={gapQuestion} />}
      <div style={CARD_STYLE}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 6px" }}>
          {t("knowledge.text_title")}
        </h3>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px", lineHeight: 1.6 }}>
          {t("knowledge.text_desc")}
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            gapQuestion
              ? `「${gapQuestion}」に回答できる情報を入力してください`
              : t("knowledge.text_placeholder")
          }
          maxLength={10000}
          style={TEXTAREA_STYLE}
        />
        <p style={{ textAlign: "right", fontSize: 12, color: text.length > 9000 ? "#ef4444" : "#6b7280", marginTop: 4 }}>
          {text.length.toLocaleString()} / 10,000
        </p>
      </div>

      <div style={CARD_STYLE}>
        <label style={{ display: "block", fontSize: 15, fontWeight: 600, color: "#d1d5db", marginBottom: 8 }}>
          {t("knowledge.category_label")}
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={SELECT_STYLE}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        {category === "" && (
          <p style={{ fontSize: 12, color: "#6b7280", margin: "6px 0 0", lineHeight: 1.5 }}>
            {t("knowledge.category_auto_desc")}
          </p>
        )}
        {isSuperAdmin && (
          <div style={{ marginTop: 16 }}>
            <GlobalKnowledgeCheckbox isGlobal={isGlobal} onChange={setIsGlobal} disabled={tenantId === "global"} />
          </div>
        )}
      </div>

      {error && (
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {success && (
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(5,46,22,0.6)", border: "1px solid rgba(74,222,128,0.3)", color: "#86efac", fontSize: 15 }}>
          {success}
        </div>
      )}

      {!preview && (
        <button
          onClick={handleConvert}
          disabled={converting || text.trim().length < 50}
          style={{
            ...BTN_PRIMARY,
            opacity: converting || text.trim().length < 50 ? 0.6 : 1,
            cursor: converting || text.trim().length < 50 ? "not-allowed" : "pointer",
          }}
        >
          {converting ? t("knowledge.converting") : t("knowledge.convert")}
        </button>
      )}

      {preview && (
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>
            {t("knowledge.preview_title", { n: preview.length })}
          </h3>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px" }}>
            {t("knowledge.preview_desc")}
          </p>
          {preview.length === 0 ? (
            <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 14, marginBottom: 16 }}>
              {t("knowledge.preview_empty")}
            </div>
          ) : (
            <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden", marginBottom: 16 }}>
              {preview.map((faq, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: "16px 18px",
                    borderBottom: idx === preview.length - 1 ? "none" : "1px solid #111827",
                  }}
                >
                  {editingIndex === idx ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <input
                        value={editQuestion}
                        onChange={(e) => setEditQuestion(e.target.value)}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#f9fafb", fontSize: 14 }}
                      />
                      <textarea
                        value={editAnswer}
                        onChange={(e) => setEditAnswer(e.target.value)}
                        rows={3}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#9ca3af", fontSize: 13, resize: "vertical" }}
                      />
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#d1d5db", fontSize: 13 }}
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={handleSaveEdit}
                          style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                        >
                          {t("knowledge.preview_edit_save")}
                        </button>
                        <button
                          onClick={() => setEditingIndex(null)}
                          style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 13, cursor: "pointer" }}
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", margin: "0 0 6px" }}>
                        Q: {faq.question}
                      </p>
                      <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 8px", lineHeight: 1.5 }}>
                        A: {faq.answer}
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                        {faq.category && (
                          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: "rgba(37,99,235,0.25)", border: "1px solid rgba(96,165,250,0.3)", color: "#93c5fd", fontSize: 11, fontWeight: 600 }}>
                            {CATEGORY_LABELS[faq.category]?.ja ?? faq.category}
                          </span>
                        )}
                        {faq.duplicate && (
                          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: "rgba(120,53,15,0.4)", border: "1px solid rgba(251,191,36,0.4)", color: "#fbbf24", fontSize: 11, fontWeight: 600 }}>
                            ⚠️ 重複の可能性: 「{faq.duplicate.existingQuestion.slice(0, 30)}{faq.duplicate.existingQuestion.length > 30 ? "…" : ""}」
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => handleStartEdit(idx, faq)}
                          style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #374151", background: "transparent", color: "#93c5fd", fontSize: 12, cursor: "pointer" }}
                        >
                          {t("knowledge.edit")}
                        </button>
                        <button
                          onClick={() => handleDeleteFaq(idx)}
                          style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(248,113,113,0.3)", background: "transparent", color: "#fca5a5", fontSize: 12, cursor: "pointer" }}
                        >
                          {t("knowledge.preview_remove")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setPreview(null)}
              style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 12, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              {t("common.retry")}
            </button>
            <button
              onClick={handleCommit}
              disabled={committing || preview.length === 0}
              style={{ ...BTN_PRIMARY, flex: 2, width: "auto", opacity: (committing || preview.length === 0) ? 0.6 : 1, cursor: (committing || preview.length === 0) ? "not-allowed" : "pointer" }}
            >
              {committing ? t("knowledge.committing") : t("knowledge.commit")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── タブ3: URLスクレイプ ────────────────────────────────────────────────────

function ScrapeTab({
  tenantId,
  onCommitSuccess,
  gapQuestion,
  gapId,
}: {
  tenantId: string;
  onCommitSuccess: () => void;
  gapQuestion?: string;
  gapId?: number;
}) {
  const navigate = useNavigate();
  const { t } = useLang();
  const { isSuperAdmin } = useAuth();

  const CATEGORIES = [
    { value: "", label: t("knowledge.category_auto") },
    { value: "inventory", label: t("category.inventory") },
    { value: "campaign", label: t("category.campaign") },
    { value: "coupon", label: t("category.coupon") },
    { value: "store_info", label: t("category.store_info") },
    { value: "product_info", label: t("category.product_info") },
    { value: "pricing", label: t("category.pricing") },
    { value: "booking", label: t("category.booking") },
    { value: "warranty", label: t("category.warranty") },
    { value: "general", label: t("category.general") },
  ];

  const [urls, setUrls] = useState("");
  const [category, setCategory] = useState<Category>("");
  const [isGlobal, setIsGlobal] = useState(tenantId === "global");
  useEffect(() => { setIsGlobal(tenantId === "global"); }, [tenantId]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ScrapePreviewItem[] | null>(null);
  const [committing, setCommitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<{ url: string; idx: number } | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editCategory, setEditCategory] = useState<string>("");

  const handleStartEdit = (url: string, idx: number, faq: FaqEntry) => {
    setEditingKey({ url, idx });
    setEditQuestion(faq.question);
    setEditAnswer(faq.answer);
    setEditCategory(faq.category ?? "");
  };
  const handleSaveEdit = () => {
    if (!editingKey || !preview) return;
    setPreview(preview.map((item) =>
      item.url === editingKey.url
        ? { ...item, faqs: item.faqs.map((f, i) => i === editingKey.idx ? { ...f, question: editQuestion.trim(), answer: editAnswer.trim(), category: editCategory || undefined } : f) }
        : item
    ));
    setEditingKey(null);
  };
  const handleDeleteFaq = (url: string, idx: number) => {
    if (!preview) return;
    setPreview(preview.map((item) =>
      item.url === url ? { ...item, faqs: item.faqs.filter((_, i) => i !== idx) } : item
    ));
  };

  const handleFetch = async () => {
    const urlList = urls
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urlList.length === 0) {
      setError(t("knowledge.url_required"));
      return;
    }
    if (urlList.length > 5) {
      setError(t("knowledge.url_max"));
      return;
    }

    setLoading(true);
    setError(null);
    setPreview(null);
    setSuccess(null);

    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/scrape?tenant=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: urlList, ...(category ? { category } : {}), ...(isGlobal ? { target: "global" } : {}) }),
      });
      if (res.status === 401 || res.status === 403) {
        navigate("/login", { replace: true });
        return;
      }
      const data = (await res.json()) as { ok?: boolean; preview?: ScrapePreviewItem[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("knowledge.load_error"));
      setPreview(data.preview ?? []);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.length === 0) return;
    const validItems = preview.filter((p) => p.faqs.length > 0);
    if (validItems.length === 0) return;

    setCommitting(true);
    setError(null);

    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/scrape/commit?tenant=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: validItems, ...(category ? { category } : {}), ...(isGlobal ? { target: "global" } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean; inserted?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("knowledge.load_error"));
      if (gapId) {
        await resolveKnowledgeGap(gapId).catch(() => {/* silent */});
        setSuccess("✅ ナレッジを追加し、未回答の質問を解決済みにしました");
      } else {
        setSuccess(t("knowledge.committed", { n: data.inserted ?? 0 }));
      }
      setPreview(null);
      setUrls("");
      onCommitSuccess();
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setCommitting(false);
    }
  };

  const totalFaqs = preview?.reduce((sum, p) => sum + p.faqs.length, 0) ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {gapQuestion && <GapQuestionBanner question={gapQuestion} />}
      {!preview && (
        <>
          <div style={CARD_STYLE}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 6px" }}>
              {t("knowledge.scrape_title")}
            </h3>
            <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px", lineHeight: 1.6 }}>
              {t("knowledge.scrape_desc")}
            </p>
            <textarea
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder={t("knowledge.scrape_placeholder")}
              style={{ ...TEXTAREA_STYLE, minHeight: 120, fontFamily: "monospace" }}
            />
          </div>

          <div style={CARD_STYLE}>
            <label style={{ display: "block", fontSize: 15, fontWeight: 600, color: "#d1d5db", marginBottom: 8 }}>
              {t("knowledge.category_label")}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={SELECT_STYLE}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            {category === "" && (
              <p style={{ fontSize: 12, color: "#6b7280", margin: "6px 0 0", lineHeight: 1.5 }}>
                {t("knowledge.category_auto_desc")}
              </p>
            )}
            {isSuperAdmin && (
              <div style={{ marginTop: 16 }}>
                <GlobalKnowledgeCheckbox isGlobal={isGlobal} onChange={setIsGlobal} disabled={tenantId === "global"} />
              </div>
            )}
          </div>
        </>
      )}

      {error && (
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {success && (
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(5,46,22,0.6)", border: "1px solid rgba(74,222,128,0.3)", color: "#86efac", fontSize: 15 }}>
          {success}
        </div>
      )}

      {loading && (
        <div style={{ padding: "20px", textAlign: "center", ...CARD_STYLE }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          <p style={{ fontSize: 15, color: "#93c5fd", margin: 0 }}>
            {t("knowledge.scraping")}
          </p>
        </div>
      )}

      {!preview && !loading && (
        <button
          onClick={handleFetch}
          disabled={urls.trim().length === 0}
          style={{
            ...BTN_PRIMARY,
            opacity: urls.trim().length === 0 ? 0.6 : 1,
            cursor: urls.trim().length === 0 ? "not-allowed" : "pointer",
          }}
        >
          {t("knowledge.fetch")}
        </button>
      )}

      {preview && preview.length > 0 && (
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>
            {t("knowledge.scrape_preview_title", { n: totalFaqs })}
          </h3>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px" }}>
            {t("knowledge.scrape_preview_desc")}
          </p>

          {preview.map((item) => (
            <div key={item.url} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                🔗 {item.url}
              </div>
              {item.error ? (
                <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 13 }}>
                  {t("knowledge.scrape_fetch_failed", { error: item.error })}
                </div>
              ) : item.faqs.length === 0 ? (
                <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 13 }}>
                  {t("knowledge.preview_empty")}
                </div>
              ) : (
                <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden" }}>
                  {item.faqs.map((faq, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: "14px 18px",
                        borderBottom: idx === item.faqs.length - 1 ? "none" : "1px solid #111827",
                      }}
                    >
                      {editingKey?.url === item.url && editingKey?.idx === idx ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <input
                            value={editQuestion}
                            onChange={(e) => setEditQuestion(e.target.value)}
                            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#f9fafb", fontSize: 14 }}
                          />
                          <textarea
                            value={editAnswer}
                            onChange={(e) => setEditAnswer(e.target.value)}
                            rows={3}
                            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#9ca3af", fontSize: 13, resize: "vertical" }}
                          />
                          <select
                            value={editCategory}
                            onChange={(e) => setEditCategory(e.target.value)}
                            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#d1d5db", fontSize: 13 }}
                          >
                            {CATEGORIES.map((c) => (
                              <option key={c.value} value={c.value}>{c.label}</option>
                            ))}
                          </select>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              onClick={handleSaveEdit}
                              style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                            >
                              {t("knowledge.preview_edit_save")}
                            </button>
                            <button
                              onClick={() => setEditingKey(null)}
                              style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 13, cursor: "pointer" }}
                            >
                              {t("common.cancel")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", margin: "0 0 6px" }}>
                            Q: {faq.question}
                          </p>
                          <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 8px", lineHeight: 1.5 }}>
                            A: {faq.answer}
                          </p>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                            {faq.category && (
                              <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: "rgba(37,99,235,0.25)", border: "1px solid rgba(96,165,250,0.3)", color: "#93c5fd", fontSize: 11, fontWeight: 600 }}>
                                {CATEGORY_LABELS[faq.category]?.ja ?? faq.category}
                              </span>
                            )}
                            {faq.duplicate && (
                              <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: "rgba(120,53,15,0.4)", border: "1px solid rgba(251,191,36,0.4)", color: "#fbbf24", fontSize: 11, fontWeight: 600 }}>
                                ⚠️ 重複の可能性: 「{faq.duplicate.existingQuestion.slice(0, 30)}{faq.duplicate.existingQuestion.length > 30 ? "…" : ""}」
                              </span>
                            )}
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              onClick={() => handleStartEdit(item.url, idx, faq)}
                              style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #374151", background: "transparent", color: "#93c5fd", fontSize: 12, cursor: "pointer" }}
                            >
                              {t("knowledge.edit")}
                            </button>
                            <button
                              onClick={() => handleDeleteFaq(item.url, idx)}
                              style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(248,113,113,0.3)", background: "transparent", color: "#fca5a5", fontSize: 12, cursor: "pointer" }}
                            >
                              {t("knowledge.preview_remove")}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button
              onClick={() => { setPreview(null); setError(null); }}
              style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 12, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              {t("common.retry")}
            </button>
            <button
              onClick={handleCommit}
              disabled={committing || totalFaqs === 0}
              style={{ ...BTN_PRIMARY, flex: 2, width: "auto", opacity: (committing || totalFaqs === 0) ? 0.6 : 1 }}
            >
              {committing ? t("knowledge.committing") : t("knowledge.commit")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PDFアップロードタブ ──────────────────────────────────────────────────────

const MAX_BOOK_PDF_SIZE = 10 * 1024 * 1024; // 10MB フロントエンド制限

interface BookUpload {
  id: number;
  tenant_id: string;
  title: string;
  original_filename: string;
  status: "uploaded" | "processing" | "chunked" | "embedded" | "failed";
  page_count: number | null;
  chunk_count: number | null;
  file_size_bytes: number | null;
  created_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: "アップロード済",
  processing: "処理中",
  chunked: "分割完了",
  embedded: "埋め込み完了",
  failed: "失敗",
};
const STATUS_COLOR: Record<string, string> = {
  uploaded: "#9ca3af",
  processing: "#60a5fa",
  chunked: "#a78bfa",
  embedded: "#4ade80",
  failed: "#f87171",
};

// ─── BookUploadsSection: グローバルナレッジページ用書籍一覧 ───────────────────

function BookUploadsSection({ tenantId }: { tenantId: string }) {
  const [books, setBooks] = useState<BookUpload[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [selectedBook, setSelectedBook] = useState<BookUpload | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const loadBooks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/book-pdf?tenant=${encodeURIComponent(tenantId)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { books?: BookUpload[] };
      setBooks(data.books ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void loadBooks(); }, [loadBooks]);

  const handleProcess = async (bookId: number) => {
    setProcessing(bookId);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/book-pdf/${bookId}/process`,
        { method: "POST" }
      );
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        showToast(err.error ?? "処理の開始に失敗しました", false);
        return;
      }
      showToast("処理を開始しました", true);
      setTimeout(() => { void loadBooks(); }, 2000);
    } catch {
      showToast("処理の開始に失敗しました", false);
    } finally {
      setProcessing(null);
    }
  };

  const statusBadgeStyle = (status: string): CSSProperties => {
    const colors: Record<string, { bg: string; color: string }> = {
      uploaded:   { bg: "rgba(156,163,175,0.15)", color: "#9ca3af" },
      processing: { bg: "rgba(251,191,36,0.15)",  color: "#fbbf24" },
      chunked:    { bg: "rgba(167,139,250,0.15)", color: "#a78bfa" },
      embedded:   { bg: "rgba(74,222,128,0.15)",  color: "#4ade80" },
      failed:     { bg: "rgba(248,113,113,0.15)", color: "#f87171" },
    };
    const c = colors[status] ?? colors["uploaded"]!;
    return {
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      background: c.bg,
      color: c.color,
    };
  };

  return (
    <div style={{ marginTop: 32 }}>
      {toast && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 9999,
          padding: "12px 20px", borderRadius: 10, fontSize: 14, fontWeight: 600,
          background: toast.ok ? "rgba(5,46,22,0.95)" : "rgba(127,29,29,0.95)",
          border: `1px solid ${toast.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"}`,
          color: toast.ok ? "#86efac" : "#fca5a5",
        }}>
          {toast.msg}
        </div>
      )}

      {selectedBook && (
        <BookChunksPanel
          bookId={selectedBook.id}
          bookTitle={selectedBook.title}
          bookStatus={selectedBook.status}
          tenantId={tenantId}
          onClose={() => setSelectedBook(null)}
          onChunkDeleted={() => { void loadBooks(); }}
        />
      )}

      <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        📚 アップロード済み書籍
      </h2>

      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>読み込み中...</div>
      ) : books.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", borderRadius: 12, border: "1px dashed #374151", color: "#6b7280", fontSize: 14 }}>
          書籍PDFがありません
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {books.map((book) => (
            <div key={book.id} style={{
              padding: "14px 16px", borderRadius: 12,
              border: "1px solid #1f2937",
              background: "rgba(15,23,42,0.6)",
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb", marginBottom: 4, wordBreak: "break-word" }}>
                  {book.title}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <span style={statusBadgeStyle(book.status)}>
                    {STATUS_LABEL[book.status] ?? book.status}
                  </span>
                  {book.chunk_count != null && (
                    <span>{book.chunk_count}件の分割テキスト</span>
                  )}
                  {book.page_count != null && (
                    <span>{book.page_count}ページ</span>
                  )}
                  <span>{new Date(book.created_at).toLocaleDateString("ja-JP")}</span>
                </div>
                {book.status === "failed" && (
                  <div style={{ fontSize: 12, color: "#f87171", marginTop: 4 }}>
                    エラーが発生しました
                  </div>
                )}
                {book.status === "embedded" && (
                  <div style={{ fontSize: 12, color: "#4ade80", marginTop: 4 }}>
                    ✅ {book.chunk_count ?? 0}件の分割テキスト埋め込み完了
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                {(book.status === "chunked" || book.status === "embedded") && (
                  <button
                    onClick={() => setSelectedBook(book)}
                    style={{
                      padding: "8px 14px", minHeight: 44, borderRadius: 8,
                      border: "1px solid rgba(96,165,250,0.4)",
                      background: "rgba(96,165,250,0.08)",
                      color: "#60a5fa",
                      fontSize: 13, fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    詳細
                  </button>
                )}
                {(book.status === "uploaded" || book.status === "failed") && (
                  <button
                    onClick={() => { void handleProcess(book.id); }}
                    disabled={processing === book.id}
                    style={{
                      padding: "8px 14px", minHeight: 44, borderRadius: 8,
                      border: "none",
                      background: processing === book.id ? "#1f2937" : book.status === "failed" ? "#7f1d1d" : "#1d4ed8",
                      color: processing === book.id ? "#6b7280" : "#fff",
                      fontSize: 13, fontWeight: 600,
                      cursor: processing === book.id ? "not-allowed" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {processing === book.id ? "処理中..." : book.status === "failed" ? "再処理" : "処理開始"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// B-2: 複数PDFアップロード用の型
type FileUploadStatus = "pending" | "uploading" | "processing" | "embedded" | "error";

interface QueuedFile {
  id: string; // ローカル管理用ユニークID
  file: File;
  title: string;
  status: FileUploadStatus;
  uploadedBookId?: number;
  errorMsg?: string;
  isZip?: boolean;
  /** ZIPアップロード後の内訳（ZIPの場合のみ） */
  zipResults?: Array<{ fileName: string; bookId?: number; status: "ok" | "error"; error?: string }>;
}

const FILE_STATUS_ICON: Record<FileUploadStatus, string> = {
  pending: "⏳",
  uploading: "📤",
  processing: "⚙️",
  embedded: "✅",
  error: "❌",
};

const FILE_STATUS_LABEL: Record<FileUploadStatus, string> = {
  pending: "待機中",
  uploading: "アップロード中",
  processing: "処理中",
  embedded: "完了",
  error: "エラー",
};

function PdfUploadTab({ tenantId }: { tenantId: string }) {
  const { isSuperAdmin } = useAuth();
  const [books, setBooks] = useState<BookUpload[]>([]);
  const [loadingBooks, setLoadingBooks] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [selectedBook, setSelectedBook] = useState<BookUpload | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const listUrl = isSuperAdmin
    ? `${API_BASE}/v1/admin/knowledge/book-pdf?tenant=${encodeURIComponent(tenantId)}`
    : `${API_BASE}/v1/admin/knowledge/book-pdf`;

  const uploadUrl = isSuperAdmin
    ? `${API_BASE}/v1/admin/knowledge/book-pdf?tenant=${encodeURIComponent(tenantId)}`
    : `${API_BASE}/v1/admin/knowledge/book-pdf`;

  const loadBooks = useCallback(async () => {
    setLoadingBooks(true);
    try {
      const res = await fetchWithAuth(listUrl);
      if (!res.ok) return;
      const data = (await res.json()) as { books?: BookUpload[] };
      setBooks(data.books ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingBooks(false);
    }
  }, [listUrl]);

  useEffect(() => { void loadBooks(); }, [loadBooks]);

  // キュー内のuploadedBookIdと照合してstatusを更新するポーリング
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const res = await fetchWithAuth(listUrl);
          if (!res.ok) return;
          const data = (await res.json()) as { books?: BookUpload[] };
          const serverBooks = data.books ?? [];
          setBooks(serverBooks);
          setQueue((prev) => {
            const updated = prev.map((q) => {
              if (!q.uploadedBookId) return q;
              const serverBook = serverBooks.find((b) => b.id === q.uploadedBookId);
              if (!serverBook) return q;
              if (serverBook.status === "embedded") return { ...q, status: "embedded" as FileUploadStatus };
              if (serverBook.status === "failed") return { ...q, status: "error" as FileUploadStatus, errorMsg: "処理に失敗しました" };
              return { ...q, status: "processing" as FileUploadStatus };
            });
            // 全件が embedded or error になったらポーリング停止
            const allDone = updated
              .filter((q) => q.uploadedBookId)
              .every((q) => q.status === "embedded" || q.status === "error");
            if (allDone && pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            return updated;
          });
        } catch {
          // ignore
        }
      })();
    }, 5000);
  }, [listUrl]);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip"]);
  const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB

  const validateAndAddFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    const newEntries: QueuedFile[] = [];
    for (const f of arr) {
      const isZip = ZIP_TYPES.has(f.type) || f.name.toLowerCase().endsWith(".zip");
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");

      if (!isPdf && !isZip) {
        showToast(`${f.name}: PDFまたはZIPファイルを選択してください`, false);
        continue;
      }

      if (isZip) {
        if (f.size > MAX_ZIP_SIZE) {
          showToast(`${f.name}: ファイルが大きすぎます。50MB以下のZIPファイルを選択してください。`, false);
          continue;
        }
        // ZIPはタイトル不要（サーバー側でファイル名から自動設定）
        newEntries.push({
          id: `${Date.now()}-${Math.random()}`,
          file: f,
          title: f.name.replace(/\.zip$/i, ""), // 表示用（実際はZIPを一括送信）
          status: "pending",
          isZip: true,
        });
        continue;
      }

      // PDF
      if (f.size > MAX_BOOK_PDF_SIZE) {
        showToast(`${f.name}: ファイルサイズが10MBを超えています`, false);
        continue;
      }
      // デフォルトタイトル: ファイル名から拡張子除去
      const defaultTitle = f.name.replace(/\.pdf$/i, "");
      newEntries.push({
        id: `${Date.now()}-${Math.random()}`,
        file: f,
        title: defaultTitle,
        status: "pending",
      });
    }
    if (newEntries.length > 0) {
      setQueue((prev) => [...prev, ...newEntries]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    validateAndAddFiles(e.dataTransfer.files);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndAddFiles(e.target.files);
      e.target.value = "";
    }
  };

  const removeFromQueue = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  };

  const updateTitle = (id: string, title: string) => {
    setQueue((prev) => prev.map((q) => q.id === id ? { ...q, title } : q));
  };

  // 順次アップロード実行
  const handleUploadAll = async () => {
    const pendingItems = queue.filter((q) => q.status === "pending");
    if (pendingItems.length === 0) return;
    if (pendingItems.some((q) => !q.isZip && !q.title.trim())) {
      showToast("全PDFファイルにタイトルを入力してください", false);
      return;
    }

    setRunning(true);
    let anyUploaded = false;

    for (const item of pendingItems) {
      // statusを「uploading」に更新
      setQueue((prev) =>
        prev.map((q) => q.id === item.id ? { ...q, status: "uploading" } : q)
      );

      try {
        const form = new FormData();
        form.append("file", item.file);
        if (!item.isZip) {
          form.append("title", item.title.trim());
        }
        const res = await fetchWithAuth(uploadUrl, { method: "POST", body: form });

        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? { ...q, status: "error", errorMsg: err.error ?? "アップロードに失敗しました" }
                : q
            )
          );
          continue;
        }

        if (item.isZip) {
          // ZIPレスポンス: { message, total, results }
          const zipResp = (await res.json()) as {
            message?: string;
            total?: number;
            results?: Array<{ fileName: string; bookId?: number; status: "ok" | "error"; error?: string }>;
          };
          const successCount = (zipResp.results ?? []).filter((r) => r.status === "ok").length;
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? {
                    ...q,
                    status: successCount > 0 ? "processing" : "error",
                    errorMsg: successCount === 0 ? "ZIPのPDFがアップロードできませんでした" : undefined,
                    zipResults: zipResp.results,
                  }
                : q
            )
          );
          if (successCount > 0) anyUploaded = true;
        } else {
          const created = (await res.json()) as { id?: number };
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? { ...q, status: "processing", uploadedBookId: created.id }
                : q
            )
          );
          anyUploaded = true;
        }
      } catch {
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? { ...q, status: "error", errorMsg: "アップロードに失敗しました" }
              : q
          )
        );
      }
    }

    setRunning(false);

    if (anyUploaded) {
      void loadBooks();
      startPolling();
    }
  };

  const pendingCount = queue.filter((q) => q.status === "pending").length;
  const hasQueue = queue.length > 0;

  return (
    <div>
      {/* トースト */}
      {toast && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 9999,
          padding: "12px 20px", borderRadius: 10, fontSize: 14, fontWeight: 600,
          background: toast.ok ? "rgba(5,46,22,0.95)" : "rgba(127,29,29,0.95)",
          border: `1px solid ${toast.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"}`,
          color: toast.ok ? "#86efac" : "#fca5a5",
        }}>
          {toast.msg}
        </div>
      )}

      {selectedBook && (
        <BookChunksPanel
          bookId={selectedBook.id}
          bookTitle={selectedBook.title}
          bookStatus={selectedBook.status}
          tenantId={tenantId}
          onClose={() => setSelectedBook(null)}
          onChunkDeleted={() => { void loadBooks(); }}
        />
      )}

      {/* ドラッグ＆ドロップゾーン（複数ファイル対応） */}
      <div style={{ marginBottom: 20 }}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${dragOver ? "#60a5fa" : "#374151"}`,
            borderRadius: 12, padding: "28px 20px", textAlign: "center",
            background: dragOver ? "rgba(96,165,250,0.06)" : "rgba(255,255,255,0.02)",
            cursor: "pointer", transition: "all 0.15s",
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.zip,application/pdf,application/zip"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
          <div style={{ fontSize: 14, color: "#9ca3af" }}>
            PDFまたはZIPをここにドラッグ＆ドロップ（複数可）
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            またはクリックして選択（PDF: 各10MB以内、ZIP: 50MB以内・最大20件）
          </div>
        </div>
      </div>

      {/* キュー表示 + タイトル入力 */}
      {hasQueue && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 8, fontWeight: 600 }}>
            アップロード予定のファイル（{queue.length}件）
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {queue.map((item) => (
              <div
                key={item.id}
                style={{
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: `1px solid ${
                    item.status === "error" ? "rgba(248,113,113,0.3)"
                    : item.status === "embedded" ? "rgba(74,222,128,0.3)"
                    : "#1f2937"
                  }`,
                  background: item.status === "error"
                    ? "rgba(127,29,29,0.15)"
                    : item.status === "embedded"
                    ? "rgba(5,46,22,0.15)"
                    : "rgba(15,23,42,0.5)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: item.status === "pending" ? 8 : 4 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>
                    {FILE_STATUS_ICON[item.status]}
                  </span>
                  <span style={{ fontSize: 13, color: "#d1d5db", flex: 1, minWidth: 0, wordBreak: "break-word" }}>
                    {item.file.name}
                  </span>
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    color: item.status === "error" ? "#fca5a5"
                      : item.status === "embedded" ? "#4ade80"
                      : item.status === "processing" ? "#fbbf24"
                      : item.status === "uploading" ? "#60a5fa"
                      : "#9ca3af",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}>
                    {FILE_STATUS_LABEL[item.status]}
                  </span>
                  {item.status === "pending" && !running && (
                    <button
                      onClick={() => removeFromQueue(item.id)}
                      style={{
                        padding: "4px 8px", minHeight: 28,
                        borderRadius: 6, border: "1px solid #374151",
                        background: "transparent", color: "#6b7280",
                        fontSize: 12, cursor: "pointer", flexShrink: 0,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* ZIPの場合: 展開メッセージ表示 */}
                {item.isZip && item.status === "pending" && (
                  <div style={{ fontSize: 12, color: "#60a5fa", marginTop: 4 }}>
                    ZIPファイル内のPDFを自動展開してアップロードします（最大20件）
                  </div>
                )}

                {/* ZIP結果内訳 */}
                {item.isZip && item.zipResults && item.zipResults.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
                    {item.zipResults.map((r, i) => (
                      <div key={i} style={{ fontSize: 11, color: r.status === "ok" ? "#4ade80" : "#fca5a5", paddingLeft: 8 }}>
                        {r.status === "ok" ? "✓" : "✗"} {r.fileName}{r.error ? `: ${r.error}` : ""}
                      </div>
                    ))}
                  </div>
                )}

                {/* タイトル入力（pendingのPDFのみ） */}
                {item.status === "pending" && !item.isZip && (
                  <input
                    type="text"
                    value={item.title}
                    onChange={(e) => updateTitle(item.id, e.target.value)}
                    placeholder="書籍タイトルを入力"
                    disabled={running}
                    style={{
                      width: "100%", padding: "8px 12px",
                      borderRadius: 7, border: "1px solid #374151",
                      background: "rgba(255,255,255,0.05)",
                      color: "#f9fafb", fontSize: 13,
                      boxSizing: "border-box",
                    }}
                  />
                )}

                {item.status === "error" && item.errorMsg && (
                  <div style={{ fontSize: 12, color: "#fca5a5", marginTop: 4 }}>
                    {item.errorMsg}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* アップロードボタン */}
          {pendingCount > 0 && (
            <button
              onClick={() => { void handleUploadAll(); }}
              disabled={running}
              style={{
                marginTop: 12,
                width: "100%", minHeight: 48, borderRadius: 10,
                border: "none",
                background: running ? "#1f2937" : "#1d4ed8",
                color: running ? "#6b7280" : "#fff",
                fontSize: 15, fontWeight: 700,
                cursor: running ? "not-allowed" : "pointer",
              }}
            >
              {running
                ? "アップロード中..."
                : `📤 ${pendingCount}件をアップロード`}
            </button>
          )}

          {/* キュークリアボタン（全件完了後） */}
          {!running && queue.every((q) => q.status === "embedded" || q.status === "error") && (
            <button
              onClick={() => setQueue([])}
              style={{
                marginTop: 8,
                width: "100%", minHeight: 44, borderRadius: 10,
                border: "1px solid #374151", background: "transparent",
                color: "#9ca3af", fontSize: 14, fontWeight: 600,
                cursor: "pointer",
              }}
            >
              リストをクリア
            </button>
          )}
        </div>
      )}

      {/* 書籍一覧 */}
      {loadingBooks ? (
        <div style={{ color: "#6b7280", fontSize: 14 }}>読み込み中...</div>
      ) : books.length === 0 ? (
        <div style={{ color: "#6b7280", fontSize: 14 }}>書籍がまだ登録されていません</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {books.map((book) => (
            <div key={book.id} style={{
              padding: "12px 16px", borderRadius: 10,
              border: "1px solid #1f2937", background: "rgba(255,255,255,0.02)",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb" }}>{book.title}</div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {book.original_filename}
                  {book.page_count != null && ` · ${book.page_count}ページ`}
                  {book.chunk_count != null && ` · ${book.chunk_count}件の分割テキスト`}
                  {book.file_size_bytes != null && ` · ${(book.file_size_bytes / 1024 / 1024).toFixed(1)}MB`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                {(book.status === "chunked" || book.status === "embedded") && (
                  <button
                    onClick={() => setSelectedBook(book)}
                    style={{
                      padding: "6px 12px", minHeight: 36, borderRadius: 8,
                      border: "1px solid rgba(96,165,250,0.4)",
                      background: "rgba(96,165,250,0.08)",
                      color: "#60a5fa",
                      fontSize: 12, fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    詳細
                  </button>
                )}
                <span style={{
                  padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                  background: "rgba(0,0,0,0.3)", color: STATUS_COLOR[book.status] ?? "#9ca3af",
                  border: `1px solid ${STATUS_COLOR[book.status] ?? "#374151"}22`,
                  whiteSpace: "nowrap",
                }}>
                  {STATUS_LABEL[book.status] ?? book.status}
                </span>
              </div>
            </div>
          ))}
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
    tabParam === "text" || tabParam === "scrape" || tabParam === "pdf" ? tabParam : "list"
  );

  // tenantId の解決: URL params → pathnameの末尾 → JWTのtenantId
  // /admin/knowledge/global のように固定パスの場合 useParams では undefined になるため
  // pathname から取得するフォールバックを追加
  const pathTenantId = tenantId ?? location.pathname.split("/").pop() ?? "";
  const resolvedTenantId = pathTenantId || user?.tenantId || "";

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
  ];

  const isGlobalTenant = resolvedTenantId === "global";

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
            onClick={() => navigate(isSuperAdmin ? "/admin/knowledge" : "/admin")}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "8px 14px", minHeight: 44, borderRadius: 999, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 14, cursor: "pointer", fontWeight: 500 }}
          >
            {isSuperAdmin ? t("nav.back_knowledge") : t("nav.back_dashboard")}
          </button>
          <LangSwitcher />
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
          {t("knowledge.title")}
        </h1>
        <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
          {isGlobalTenant
            ? t("knowledge.global_desc")
            : t("knowledge.subtitle")}
          {resolvedTenantId && !isGlobalTenant && (
            <span style={{ marginLeft: 8, fontFamily: "monospace", color: "#6b7280", fontSize: 12 }}>
              ({resolvedTenantId})
            </span>
          )}
        </p>
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
    </div>
  );
}
