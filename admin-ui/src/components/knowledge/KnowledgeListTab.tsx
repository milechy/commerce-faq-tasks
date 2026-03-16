import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import KnowledgeFaqEditModal, { type KnowledgeFaqItem } from "../KnowledgeFaqEditModal";
import { useLang } from "../../i18n/LangContext";
import { API_BASE } from "../../lib/api";
import {
  type KnowledgeItem,
  type DeleteState,
  fetchWithAuth,
  formatDate,
  CARD_STYLE,
  BTN_DANGER,
} from "./shared";
import FaqSearchBar from "./FaqSearchBar";
import Pagination from "./Pagination";
import BulkActionBar from "./BulkActionBar";

type SortKey = "created_at" | "updated_at" | "category";

export default function KnowledgeListTab({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const locale = lang === "en" ? "en-US" : "ja-JP";

  const CATEGORIES = [
    { value: "inventory", label: t("category.inventory") },
    { value: "campaign", label: t("category.campaign") },
    { value: "coupon", label: t("category.coupon") },
    { value: "store_info", label: t("category.store_info") },
  ];

  // ─── List state ───────────────────────────────────────────────────────────
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  // ─── Filter / sort / pagination state ────────────────────────────────────
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [currentOffset, setCurrentOffset] = useState(0);
  const [pageLimit, setPageLimit] = useState(50);

  // ─── Selection / bulk state ───────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // ─── Modal / toast state ──────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    question: string;
    state: DeleteState;
    error?: string;
  } | null>(null);
  const [editTarget, setEditTarget] = useState<KnowledgeFaqItem | null>(null);
  const [createMode, setCreateMode] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ─── Debounce search ──────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setCurrentOffset(0);
      setSelectedIds(new Set());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ─── Fetch FAQs ───────────────────────────────────────────────────────────
  const fetchFaqs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        tenant: tenantId,
        limit: String(pageLimit),
        offset: String(currentOffset),
        sort: sortKey,
        order: sortOrder,
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (categoryFilter !== "all") params.set("category", categoryFilter);

      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/faq?${params}`
      );
      if (!res.ok) throw new Error(t("knowledge.load_error"));

      const data = (await res.json()) as {
        items?: KnowledgeItem[];
        faqs?: KnowledgeItem[];
        total: number;
      };
      setItems(data.faqs ?? data.items ?? []);
      setTotalCount(data.total ?? 0);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(
        err instanceof Error ? err.message : t("knowledge.load_error")
      );
    } finally {
      setLoading(false);
    }
  }, [
    navigate,
    categoryFilter,
    debouncedSearch,
    sortKey,
    sortOrder,
    currentOffset,
    pageLimit,
    t,
  ]);

  useEffect(() => {
    void fetchFaqs();
  }, [fetchFaqs]);

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleModalSuccess = (msg: string) => {
    setEditTarget(null);
    setCreateMode(false);
    showToast(msg);
    void fetchFaqs();
  };

  const categoryLabel = (cat: string | null) => {
    const found = CATEGORIES.find((c) => c.value === cat);
    return found ? found.label : cat ?? t("knowledge.uncategorized");
  };

  // ─── Category / sort handlers ─────────────────────────────────────────────
  const handleCategoryChange = (cat: string) => {
    setCategoryFilter(cat);
    setCurrentOffset(0);
    setSelectedIds(new Set());
  };

  const handleSortChange = (value: string) => {
    const parts = value.split("_");
    const ord = parts.pop() as "asc" | "desc";
    const key = parts.join("_") as SortKey;
    setSortKey(key);
    setSortOrder(ord);
    setCurrentOffset(0);
  };

  // ─── Single-item delete ───────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteTarget((prev) => (prev ? { ...prev, state: "deleting" } : null));
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/${deleteTarget.id}?tenant=${tenantId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(t("knowledge.delete_error"));
      setDeleteTarget((prev) => (prev ? { ...prev, state: "success" } : null));
      setItems((prev) => prev.filter((i) => i.id !== deleteTarget.id));
      setTotalCount((prev) => Math.max(0, prev - 1));
      setTimeout(() => setDeleteTarget(null), 2000);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setDeleteTarget((prev) =>
        prev
          ? {
              ...prev,
              state: "error",
              error:
                err instanceof Error ? err.message : t("knowledge.delete_error"),
            }
          : null
      );
    }
  };

  // ─── Selection helpers ────────────────────────────────────────────────────
  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    const pageIds = items.map((f) => f.id);
    const allSelected =
      pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  // ─── Bulk delete ──────────────────────────────────────────────────────────
  const handleBulkDelete = async () => {
    const count = selectedIds.size;
    const msg =
      lang === "ja"
        ? `本当に${count}件のFAQを削除しますか？この操作は元に戻せません。`
        : `Are you sure you want to delete ${count} FAQs? This cannot be undone.`;
    if (!window.confirm(msg)) return;

    setIsBulkDeleting(true);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/faq/bulk?tenant=${tenantId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: Array.from(selectedIds) }),
        }
      );
      if (res.ok) {
        setSelectedIds(new Set());
        showToast(
          lang === "ja"
            ? `${count}件のFAQを削除しました`
            : `Deleted ${count} FAQs`
        );
        void fetchFaqs();
      } else {
        showToast(
          lang === "ja"
            ? "削除に失敗しました。もう一度お試しください"
            : "Failed to delete. Please try again."
        );
      }
    } catch {
      showToast(
        lang === "ja"
          ? "削除に失敗しました。もう一度お試しください"
          : "Failed to delete. Please try again."
      );
    } finally {
      setIsBulkDeleting(false);
    }
  };

  // ─── Derived ──────────────────────────────────────────────────────────────
  const pageIds = items.map((f) => f.id);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));

  return (
    <div style={{ paddingBottom: selectedIds.size > 0 ? 88 : 0 }}>
      {/* 新規追加ボタン */}
      <button
        onClick={() => setCreateMode(true)}
        style={{
          width: "100%",
          padding: "18px 24px",
          minHeight: 60,
          borderRadius: 14,
          border: "none",
          background:
            "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
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

      {/* 検索バー */}
      <FaqSearchBar value={searchQuery} onChange={setSearchQuery} />

      {/* カテゴリフィルター + ソート + 更新ボタン */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 16,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 14, color: "#9ca3af" }}>
          {t("knowledge.category_filter")}
        </span>
        {[{ value: "all", label: t("knowledge.all") }, ...CATEGORIES].map(
          (c) => (
            <button
              key={c.value}
              onClick={() => handleCategoryChange(c.value)}
              style={{
                padding: "6px 14px",
                minHeight: 36,
                borderRadius: 999,
                border: `1px solid ${
                  categoryFilter === c.value ? "#22c55e" : "#374151"
                }`,
                background:
                  categoryFilter === c.value
                    ? "rgba(34,197,94,0.15)"
                    : "transparent",
                color:
                  categoryFilter === c.value ? "#4ade80" : "#9ca3af",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {c.label}
            </button>
          )
        )}

        {/* ソートドロップダウン */}
        <select
          value={`${sortKey}_${sortOrder}`}
          onChange={(e) => handleSortChange(e.target.value)}
          style={{
            padding: "6px 10px",
            minHeight: 36,
            borderRadius: 8,
            border: "1px solid #374151",
            background: "rgba(15,23,42,0.8)",
            color: "#9ca3af",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          <option value="created_at_desc">{t("knowledge.sort_newest")}</option>
          <option value="created_at_asc">{t("knowledge.sort_oldest")}</option>
          <option value="updated_at_desc">{t("knowledge.sort_updated")}</option>
          <option value="category_asc">{t("knowledge.sort_category")}</option>
        </select>

        <button
          onClick={() => void fetchFaqs()}
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

      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 15,
          }}
        >
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div
          style={{ padding: 40, textAlign: "center", color: "#6b7280" }}
        >
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>
            ⏳
          </span>
          {t("knowledge.loading")}
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            borderRadius: 14,
            border: "1px dashed #374151",
            background: "rgba(15,23,42,0.4)",
          }}
        >
          <span style={{ display: "block", fontSize: 40, marginBottom: 12 }}>
            📭
          </span>
          <p
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: "#d1d5db",
              margin: 0,
            }}
          >
            {t("knowledge.empty_title")}
          </p>
          <p
            style={{
              fontSize: 13,
              color: "#6b7280",
              marginTop: 6,
              marginBottom: 0,
            }}
          >
            {t("knowledge.empty_sub")}
          </p>
        </div>
      ) : (
        <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden" }}>
          {/* ヘッダー行: 全選択 + 件数 */}
          <div
            style={{
              padding: "12px 18px",
              borderBottom: "1px solid #111827",
              fontSize: 13,
              color: "#6b7280",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                minHeight: 32,
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={allPageSelected}
                ref={(el) => {
                  if (el)
                    el.indeterminate = somePageSelected && !allPageSelected;
                }}
                onChange={toggleSelectAll}
                style={{ width: 18, height: 18, cursor: "pointer", accentColor: "#22c55e" }}
              />
              <span>{t("knowledge.select_all")}</span>
            </label>
            <span style={{ marginLeft: "auto" }}>
              {t("knowledge.count", { n: totalCount })}
            </span>
          </div>

          {/* FAQ行 */}
          {items.map((item, idx) => (
            <div
              key={item.id}
              style={{
                padding: "16px 18px",
                borderBottom:
                  idx === items.length - 1 ? "none" : "1px solid #111827",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                flexWrap: "wrap",
                background: selectedIds.has(item.id)
                  ? "rgba(34,197,94,0.04)"
                  : "transparent",
              }}
            >
              {/* チェックボックス */}
              <div style={{ paddingTop: 2, flexShrink: 0 }}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={() => toggleSelect(item.id)}
                  style={{
                    width: 18,
                    height: 18,
                    cursor: "pointer",
                    accentColor: "#22c55e",
                  }}
                />
              </div>

              <div style={{ flex: 1, minWidth: 200 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "rgba(34,197,94,0.1)",
                      border: "1px solid rgba(34,197,94,0.2)",
                      color: "#4ade80",
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {categoryLabel(item.category)}
                  </span>
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    {formatDate(item.created_at, locale)}
                  </span>
                </div>
                <p
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: "#f9fafb",
                    margin: "0 0 4px",
                    lineHeight: 1.4,
                  }}
                >
                  Q: {item.question}
                </p>
                <p
                  style={{
                    fontSize: 13,
                    color: "#9ca3af",
                    margin: 0,
                    lineHeight: 1.5,
                  }}
                >
                  A:{" "}
                  {item.answer.slice(0, 120)}
                  {item.answer.length > 120 ? "…" : ""}
                </p>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexShrink: 0,
                  alignItems: "center",
                }}
              >
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
                  onClick={() =>
                    setDeleteTarget({
                      id: item.id,
                      question: item.question,
                      state: "confirming",
                    })
                  }
                  style={BTN_DANGER}
                >
                  {t("knowledge.delete")}
                </button>
              </div>
            </div>
          ))}

          {/* ページネーション */}
          <div style={{ padding: "0 18px" }}>
            <Pagination
              total={totalCount}
              limit={pageLimit}
              offset={currentOffset}
              onPageChange={(newOffset) => {
                setCurrentOffset(newOffset);
              }}
              onLimitChange={(newLimit) => {
                setPageLimit(newLimit);
                setCurrentOffset(0);
              }}
            />
          </div>
        </div>
      )}

      {/* バルク操作バー */}
      <BulkActionBar
        selectedCount={selectedIds.size}
        onBulkDelete={handleBulkDelete}
        onClearSelection={() => setSelectedIds(new Set())}
        loading={isBulkDeleting}
      />

      {/* 編集モーダル */}
      {editTarget && (
        <KnowledgeFaqEditModal
          mode="edit"
          tenantId={tenantId}
          item={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={handleModalSuccess}
        />
      )}

      {/* 新規作成モーダル */}
      {createMode && (
        <KnowledgeFaqEditModal
          mode="create"
          tenantId={tenantId}
          onClose={() => setCreateMode(false)}
          onSuccess={handleModalSuccess}
        />
      )}

      {/* トースト通知 */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: selectedIds.size > 0 ? 104 : 32,
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

      {/* 削除確認ダイアログ */}
      {deleteTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
          onClick={(e) => {
            if (
              e.target === e.currentTarget &&
              deleteTarget.state !== "deleting"
            )
              setDeleteTarget(null);
          }}
        >
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #1f2937",
              borderRadius: 16,
              padding: "28px 24px",
              maxWidth: 420,
              width: "100%",
              boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
            }}
          >
            {deleteTarget.state === "success" ? (
              <div style={{ textAlign: "center" }}>
                <span
                  style={{
                    fontSize: 48,
                    display: "block",
                    marginBottom: 12,
                  }}
                >
                  ✅
                </span>
                <p
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    color: "#4ade80",
                    margin: 0,
                  }}
                >
                  {t("knowledge.deleted")}
                </p>
              </div>
            ) : (
              <>
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: "#f9fafb",
                    margin: "0 0 12px",
                  }}
                >
                  {t("knowledge.delete_confirm_title")}
                </h3>
                <p
                  style={{
                    fontSize: 14,
                    color: "#d1d5db",
                    margin: "0 0 6px",
                  }}
                >
                  Q: {deleteTarget.question}
                </p>
                <p
                  style={{
                    fontSize: 13,
                    color: "#9ca3af",
                    margin: "0 0 20px",
                    lineHeight: 1.6,
                  }}
                >
                  {t("knowledge.delete_confirm_body")}
                </p>
                {deleteTarget.state === "error" && deleteTarget.error && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: "10px 14px",
                      borderRadius: 8,
                      background: "rgba(127,29,29,0.4)",
                      color: "#fca5a5",
                      fontSize: 14,
                    }}
                  >
                    {deleteTarget.error}
                  </div>
                )}
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={() => setDeleteTarget(null)}
                    disabled={deleteTarget.state === "deleting"}
                    style={{
                      flex: 1,
                      padding: "14px",
                      minHeight: 56,
                      borderRadius: 10,
                      border: "1px solid #374151",
                      background: "transparent",
                      color: "#e5e7eb",
                      fontSize: 15,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {t("knowledge.cancel_delete")}
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleteTarget.state === "deleting"}
                    style={{
                      flex: 1,
                      padding: "14px",
                      minHeight: 56,
                      borderRadius: 10,
                      border: "none",
                      background:
                        "linear-gradient(135deg, #991b1b, #dc2626)",
                      color: "#fee2e2",
                      fontSize: 15,
                      fontWeight: 700,
                      cursor:
                        deleteTarget.state === "deleting"
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    {deleteTarget.state === "deleting"
                      ? t("common.deleting")
                      : t("knowledge.confirm_delete")}
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
