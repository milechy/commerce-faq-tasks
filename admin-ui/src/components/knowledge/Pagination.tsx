import type { CSSProperties } from "react";
import { useLang } from "../../i18n/LangContext";

interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onPageChange: (newOffset: number) => void;
  onLimitChange: (newLimit: number) => void;
}

export default function Pagination({
  total,
  limit,
  offset,
  onPageChange,
  onLimitChange,
}: PaginationProps) {
  const { t } = useLang();

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  const isPrevDisabled = offset <= 0;
  const isNextDisabled = offset + limit >= total;

  const btnStyle = (disabled: boolean): CSSProperties => ({
    padding: "8px 16px",
    minHeight: 40,
    borderRadius: 8,
    border: `1px solid ${disabled ? "#1f2937" : "#374151"}`,
    background: disabled ? "transparent" : "rgba(34,197,94,0.08)",
    color: disabled ? "#4b5563" : "#4ade80",
    fontSize: 14,
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 12,
        padding: "14px 0",
        marginTop: 4,
        borderTop: "1px solid #111827",
      }}
    >
      {/* 件数表示 */}
      <span style={{ fontSize: 13, color: "#9ca3af" }}>
        {t("knowledge.showing", { total, from, to })}
      </span>

      {/* ページナビゲーション */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => onPageChange(offset - limit)}
          disabled={isPrevDisabled}
          style={btnStyle(isPrevDisabled)}
        >
          {t("knowledge.prev")}
        </button>
        <span style={{ fontSize: 13, color: "#9ca3af", whiteSpace: "nowrap" }}>
          {t("knowledge.page_of", { current: currentPage, total: totalPages })}
        </span>
        <button
          onClick={() => onPageChange(offset + limit)}
          disabled={isNextDisabled}
          style={btnStyle(isNextDisabled)}
        >
          {t("knowledge.next")}
        </button>
      </div>

      {/* 件数セレクト */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          value={limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #374151",
            background: "rgba(15,23,42,0.8)",
            color: "#e5e7eb",
            fontSize: 13,
            minHeight: 36,
            cursor: "pointer",
          }}
        >
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
        <span style={{ fontSize: 13, color: "#9ca3af" }}>
          {t("knowledge.per_page")}
        </span>
      </div>
    </div>
  );
}
