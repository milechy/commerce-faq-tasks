import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import KnowledgeFaqEditModal, { type KnowledgeFaqItem } from "../KnowledgeFaqEditModal";
import FaqHintSettings from "./FaqHintSettings";
import AllowedOriginsSettings from "./AllowedOriginsSettings";
import FaqSearchBar from "./FaqSearchBar";
import BulkActionBar from "./BulkActionBar";
import { Pagination } from "../common/Pagination";
import { useLang } from "../../i18n/LangContext";
import { useAuth } from "../../auth/useAuth";
import { API_BASE } from "../../lib/api";
import { fetchWithAuth, formatDate, CARD_STYLE, BTN_DANGER, CATEGORY_LABEL_MAP } from "./shared";

interface KnowledgeItem {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  tags: string[] | null;
  is_published?: boolean;
  is_excluded_from_search?: boolean;
  created_at: string;
}

type DeleteState = "idle" | "confirming" | "deleting" | "success" | "error";
type SortOption = "newest" | "oldest" | "updated" | "category";

const SORT_PARAMS: Record<SortOption, { sort: "created_at" | "updated_at" | "category"; order: "asc" | "desc" }> = {
  newest: { sort: "created_at", order: "desc" },
  oldest: { sort: "created_at", order: "asc" },
  updated: { sort: "updated_at", order: "desc" },
  category: { sort: "category", order: "asc" },
};

const PAGE_SIZE = 20;

// ─── タブ1: ナレッジ一覧 ────────────────────────────────────────────────────

export default function KnowledgeListTab({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const { isSuperAdmin } = useAuth();
  const locale = lang === "en" ? "en-US" : "ja-JP";
  const [faqHints, setFaqHints] = useState<{ questionHint: string | null; answerHint: string | null }>({
    questionHint: null,
    answerHint: null,
  });

  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sortOption, setSortOption] = useState<SortOption>("newest");
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

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  // 既定9カテゴリ + 実データで見つかった値を累積（フィルタを変えてもチップが消えない）
  const [knownCategories, setKnownCategories] = useState<Set<string>>(
    () => new Set(Object.keys(CATEGORY_LABEL_MAP))
  );

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // 検索入力の debounce（連打での過剰リクエストを防ぐ）
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 絞り込み条件が変わったら1ページ目に戻す
  useEffect(() => {
    setOffset(0);
  }, [search, sortOption, categoryFilter, publishFilter]);

  const categoryLabel = useCallback(
    (cat: string | null) => {
      if (!cat) return t("knowledge.uncategorized");
      return CATEGORY_LABEL_MAP[cat]?.[lang === "en" ? "en" : "ja"] ?? cat;
    },
    [t, lang]
  );

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { sort, order } = SORT_PARAMS[sortOption];
      const params = new URLSearchParams({
        tenant: tenantId,
        limit: String(PAGE_SIZE),
        offset: String(offset),
        sort,
        order,
      });
      if (search) params.set("search", search);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (publishFilter === "published") params.set("is_published", "true");
      if (publishFilter === "draft") params.set("is_published", "false");

      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/faq?${params}`);
      if (!res.ok) throw new Error(t("knowledge.load_error"));
      const data = (await res.json()) as { items: KnowledgeItem[]; total: number };
      const fetchedItems = data.items ?? [];
      setItems(fetchedItems);
      setTotal(data.total ?? 0);
      setKnownCategories((prev) => {
        const next = new Set(prev);
        for (const item of fetchedItems) if (item.category) next.add(item.category);
        return next;
      });
      // 選択済みIDのうち、現在ページにまだ存在するものだけ残す
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const visibleIds = new Set(fetchedItems.map((i) => i.id));
        const next = new Set<number>();
        for (const id of prev) if (visibleIds.has(id)) next.add(id);
        return next;
      });
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setLoading(false);
    }
  }, [navigate, tenantId, offset, search, sortOption, categoryFilter, publishFilter, t]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const handleModalSuccess = (msg: string) => {
    setEditTarget(null);
    setCreateMode(false);
    showToast(msg);
    void fetchItems();
  };

  const fetchAuthRequired = (err: unknown): boolean => {
    if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleteTarget((prev) => prev ? { ...prev, state: "deleting" } : null);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/faq/${deleteTarget.id}?tenant=${tenantId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(t("knowledge.delete_error"));
      setDeleteTarget((prev) => prev ? { ...prev, state: "success" } : null);
      setTimeout(() => {
        setDeleteTarget(null);
        void fetchItems();
      }, 1500);
    } catch (err) {
      if (fetchAuthRequired(err)) return;
      setDeleteTarget((prev) =>
        prev ? { ...prev, state: "error", error: err instanceof Error ? err.message : t("knowledge.delete_error") } : null
      );
    }
  };

  const handleTogglePublish = async (item: KnowledgeItem) => {
    setTogglingId(item.id);
    try {
      const newState = !item.is_published;
      const res = await fetchWithAuth(
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
      if (!res.ok) throw new Error();
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, is_published: newState } : i))
      );
    } catch (err) {
      if (fetchAuthRequired(err)) return;
      // no-op（既存動作踏襲: トグル失敗時は静かに戻す）
    } finally {
      setTogglingId(null);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allOnPageSelected = items.length > 0 && items.every((i) => selectedIds.has(i.id));
  const toggleSelectAll = () => {
    setSelectedIds(allOnPageSelected ? new Set() : new Set(items.map((i) => i.id)));
  };

  const handleBulkUnpublish = async () => {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    setBulkLoading(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/faq/bulk-publish?tenant=${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds), is_published: false }),
      });
      if (!res.ok) throw new Error();
      setSelectedIds(new Set());
      showToast(t("knowledge.bulk_unpublish_success", { n }));
      void fetchItems();
    } catch (err) {
      if (fetchAuthRequired(err)) return;
      showToast(t("knowledge.bulk_action_error"));
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/faq/bulk?tenant=${tenantId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      if (!res.ok) throw new Error();
      setSelectedIds(new Set());
      showToast(t("knowledge.deleted"));
      void fetchItems();
    } catch (err) {
      if (fetchAuthRequired(err)) return;
      showToast(t("knowledge.bulk_action_error"));
    } finally {
      setBulkLoading(false);
    }
  };

  const sortedKnownCategories = useMemo(() => Array.from(knownCategories).sort(), [knownCategories]);

  const editCategories = useMemo(
    () => sortedKnownCategories.map((c) => ({ value: c, label: categoryLabel(c) })),
    [sortedKnownCategories, categoryLabel]
  );

  return (
    <div>
      {/* GID 1216274385106667: FAQ登録フォームの入力例カスタマイズ */}
      <FaqHintSettings
        tenantId={tenantId}
        isSuperAdmin={isSuperAdmin}
        onHintsLoaded={setFaqHints}
      />

      {/* LAUNCH: Widget許可ドメインのテナント自己設定。
          super_adminは/admin/tenants/:idのSettingsTab（ワイルドカード対応）で管理するため、
          ここではclient_adminのみに表示する（二重UI防止）。 */}
      {!isSuperAdmin && <AllowedOriginsSettings tenantId={tenantId} />}

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

      {/* 検索 */}
      <FaqSearchBar value={searchInput} onChange={setSearchInput} />

      {/* カテゴリ絞り込み */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 14, color: "#9ca3af" }}>{t("knowledge.category_filter")}</span>
        {[{ value: "all", label: t("knowledge.all") }, ...sortedKnownCategories.map((c) => ({ value: c, label: categoryLabel(c) }))].map((c) => (
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

      {/* 並び順 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#6b7280" }}>{t("knowledge.sort_label")}</span>
        <select
          value={sortOption}
          onChange={(e) => setSortOption(e.target.value as SortOption)}
          style={{
            padding: "6px 10px",
            minHeight: 36,
            borderRadius: 8,
            border: "1px solid #374151",
            background: "rgba(15,23,42,0.8)",
            color: "#d1d5db",
            fontSize: 13,
          }}
        >
          <option value="newest">{t("knowledge.sort_newest")}</option>
          <option value="oldest">{t("knowledge.sort_oldest")}</option>
          <option value="updated">{t("knowledge.sort_updated")}</option>
          <option value="category">{t("knowledge.sort_category")}</option>
        </select>
      </div>

      {/* AI回答状態フィルター */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
        {(["all", "published", "draft"] as const).map((v) => {
          const label =
            v === "all" ? t("knowledge.filter_status_all")
              : v === "published" ? t("knowledge.filter_answering")
              : t("knowledge.filter_not_answering");
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
          <div style={{ padding: "12px 18px", borderBottom: "1px solid #111827", fontSize: 13, color: "#6b7280", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "#9ca3af" }}>
              <input
                type="checkbox"
                checked={allOnPageSelected}
                onChange={toggleSelectAll}
                style={{ width: 18, height: 18, cursor: "pointer" }}
              />
              {t("knowledge.select_all")}
            </label>
            <span>
              {total > 0
                ? t("knowledge.showing", { total, from: offset + 1, to: Math.min(offset + items.length, total) })
                : t("knowledge.count", { n: items.length })}
            </span>
          </div>
          {selectedIds.size === 0 && (
            <div style={{ padding: "0 18px 12px", fontSize: 12, color: "#4b5563" }}>
              {t("knowledge.bulk_select_hint")}
            </div>
          )}
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
              <input
                type="checkbox"
                checked={selectedIds.has(item.id)}
                onChange={() => toggleSelect(item.id)}
                style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0, cursor: "pointer" }}
              />
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
                      ? t("knowledge.badge_not_answering")
                      : t("knowledge.badge_answering")}
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
                    ? t("knowledge.action_unmute")
                    : t("knowledge.action_mute")}
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
                      is_excluded_from_search: item.is_excluded_from_search,
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

      <Pagination total={total} limit={PAGE_SIZE} offset={offset} onPageChange={setOffset} />

      {editTarget && (
        <KnowledgeFaqEditModal
          mode="edit"
          tenantId={tenantId}
          item={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={handleModalSuccess}
          questionHint={faqHints.questionHint}
          answerHint={faqHints.answerHint}
          categories={editCategories}
        />
      )}

      {createMode && (
        <KnowledgeFaqEditModal
          mode="create"
          tenantId={tenantId}
          onClose={() => setCreateMode(false)}
          onSuccess={handleModalSuccess}
          questionHint={faqHints.questionHint}
          answerHint={faqHints.answerHint}
          categories={editCategories}
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

      <BulkActionBar
        selectedCount={selectedIds.size}
        onBulkUnpublish={handleBulkUnpublish}
        onBulkDelete={handleBulkDelete}
        onClearSelection={() => setSelectedIds(new Set())}
        loading={bulkLoading}
      />

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
