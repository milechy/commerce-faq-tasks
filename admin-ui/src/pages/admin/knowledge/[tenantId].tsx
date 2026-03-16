import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import FileUpload from "../../../components/admin/FileUpload";
import { API_BASE } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";
import KnowledgeFaqEditModal, { type KnowledgeFaqItem } from "../../../components/KnowledgeFaqEditModal";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { SuperAdminOnly } from "../../../components/RoleGuard";
import { useAuth } from "../../../auth/useAuth";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface BookMetadata {
  id: string;
  title: string;
  author: string;
  totalPages: number;
  totalChunks: number;
  uploadedAt: number;
}

interface KnowledgeItem {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  tags: string[] | null;
  is_published?: boolean;
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

interface OcrJobStatus {
  status: "processing" | "done" | "failed";
  pages?: number;
  chunks?: number;
  error?: string;
}

type Tab = "list" | "text" | "scrape";
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

// ─── グローバルナレッジチェックボックス（Super Admin専用） ────────────────────

function GlobalKnowledgeCheckbox({
  isGlobal,
  onChange,
}: {
  isGlobal: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useLang();
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        cursor: "pointer",
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
      }}
    >
      <input
        type="checkbox"
        checked={isGlobal}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, accentColor: "#fbbf24", cursor: "pointer" }}
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
  }, [navigate, tenantId, categoryFilter, publishFilter, t]);

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
      <div style={{ display: "flex", gap: 6, marginBottom: 16, alignItems: "center" }}>
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

function TextInputTab({ tenantId }: { tenantId: string }) {
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
  const [isGlobal, setIsGlobal] = useState(false);
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
      setSuccess(t("knowledge.committed", { n: data.inserted ?? 0 }));
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
          placeholder={t("knowledge.text_placeholder")}
          style={TEXTAREA_STYLE}
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
            <GlobalKnowledgeCheckbox isGlobal={isGlobal} onChange={setIsGlobal} />
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

function ScrapeTab({ tenantId, onCommitSuccess }: { tenantId: string; onCommitSuccess: () => void }) {
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
  const [isGlobal, setIsGlobal] = useState(false);
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
      setSuccess(t("knowledge.committed", { n: data.inserted ?? 0 }));
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
                <GlobalKnowledgeCheckbox isGlobal={isGlobal} onChange={setIsGlobal} />
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

// ─── PDFアップロードセクション（Super Admin専用） ────────────────────────────

function PdfSection({ tenantId }: { tenantId: string }) {
  const { t } = useLang();
  const { isSuperAdmin } = useAuth();
  const [isGlobal, setIsGlobal] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<OcrJobStatus | null>(null);
  const [books, setBooks] = useState<BookMetadata[]>([]);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadBooks = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge?tenant=${tenantId}`);
      if (!res.ok) return;
      const data = (await res.json()) as { items?: unknown[]; count?: number };
      setBooks((data.items ?? []) as BookMetadata[]);
    } catch {
      // ignore
    }
  }, [tenantId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBooks();
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!currentJobId) return;
    const poll = async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/jobs/${currentJobId}`);
        if (!res.ok) return;
        const data = (await res.json()) as OcrJobStatus;
        setJobStatus(data);
        if (data.status === "done" || data.status === "failed") {
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
          setCurrentJobId(null);
          if (data.status === "done") void loadBooks();
        }
      } catch {
        // ignore
      }
    };
    void poll();
    pollingRef.current = setInterval(() => void poll(), 10_000);
    return () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  }, [currentJobId, loadBooks]);

  const uploadEndpoint = isGlobal
    ? `/v1/admin/knowledge/pdf?tenant=${tenantId}&target=global`
    : `/v1/admin/knowledge/pdf?tenant=${tenantId}`;

  return (
    <div style={{ ...CARD_STYLE, marginBottom: 24 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", margin: "0 0 12px" }}>
        {t("knowledge.pdf_title")}
      </h3>
      {isSuperAdmin && (
        <GlobalKnowledgeCheckbox isGlobal={isGlobal} onChange={setIsGlobal} />
      )}
      <FileUpload
        uploadEndpoint={uploadEndpoint}
        onUploadSuccess={(name) => { setUploadSuccess(name); setTimeout(() => setUploadSuccess(null), 5000); }}
        onUploadResponse={(data) => {
          const d = data as { jobId?: string } | null;
          if (d?.jobId) { setJobStatus({ status: "processing" }); setCurrentJobId(d.jobId); }
        }}
      />
      {uploadSuccess && (
        <div style={{ marginTop: 10, padding: "12px 16px", borderRadius: 10, background: "rgba(5,46,22,0.5)", border: "1px solid rgba(74,222,128,0.3)", color: "#86efac", fontSize: 14 }}>
          {t("knowledge.pdf_accepted", { name: uploadSuccess })}
        </div>
      )}
      {jobStatus && (
        <div style={{
          marginTop: 10, padding: "12px 16px", borderRadius: 10, fontSize: 14,
          border: `1px solid ${jobStatus.status === "done" ? "rgba(74,222,128,0.3)" : jobStatus.status === "failed" ? "rgba(248,113,113,0.3)" : "rgba(96,165,250,0.3)"}`,
          background: jobStatus.status === "done" ? "rgba(5,46,22,0.5)" : jobStatus.status === "failed" ? "rgba(127,29,29,0.4)" : "rgba(23,37,84,0.5)",
          color: jobStatus.status === "done" ? "#86efac" : jobStatus.status === "failed" ? "#fca5a5" : "#93c5fd",
        }}>
          {jobStatus.status === "processing" && t("knowledge.pdf_processing")}
          {jobStatus.status === "done" && t("knowledge.pdf_done", { pages: jobStatus.pages ?? 0, chunks: jobStatus.chunks ?? 0 })}
          {jobStatus.status === "failed" && t("knowledge.pdf_failed", { error: jobStatus.error ?? "" })}
        </div>
      )}
      {books.length > 0 && (
        <p style={{ fontSize: 12, color: "#6b7280", margin: "10px 0 0" }}>
          {t("knowledge.pdf_registered", { n: books.length })}
        </p>
      )}
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

export default function TenantKnowledgePage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { tenantId } = useParams<{ tenantId: string }>();
  const { user, isSuperAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("list");

  // tenantId の解決: URL params → JWTのtenantId → フォールバック
  const resolvedTenantId = tenantId ?? user?.tenantId ?? "";

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

      {/* PDFアップロード — super_admin のみ */}
      <SuperAdminOnly>
        <PdfSection tenantId={resolvedTenantId} />
      </SuperAdminOnly>

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
      {activeTab === "list" && <KnowledgeListTab tenantId={resolvedTenantId} />}
      {activeTab === "text" && <TextInputTab tenantId={resolvedTenantId} />}
      {activeTab === "scrape" && <ScrapeTab tenantId={resolvedTenantId} onCommitSuccess={() => setActiveTab("list")} />}
    </div>
  );
}
