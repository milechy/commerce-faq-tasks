// admin-ui/src/components/common/Pagination.tsx
// Phase52b: ページネーション共通コンポーネント

interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onPageChange: (newOffset: number) => void;
}

export function Pagination({ total, limit, offset, onPageChange }: PaginationProps) {
  if (total <= limit) return null;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  const btnStyle = (disabled: boolean): React.CSSProperties => ({
    padding: "10px 20px",
    minHeight: 44,
    borderRadius: 10,
    border: "1px solid #374151",
    background: "rgba(15,23,42,0.8)",
    color: disabled ? "#374151" : "#9ca3af",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
  });

  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 24, alignItems: "center" }}>
      <button
        onClick={() => onPageChange(offset - limit)}
        disabled={!hasPrev}
        style={btnStyle(!hasPrev)}
      >
        ← 前へ
      </button>
      <span style={{ display: "flex", alignItems: "center", fontSize: 13, color: "#6b7280", padding: "0 12px" }}>
        ページ {currentPage}/{totalPages}
      </span>
      <button
        onClick={() => onPageChange(offset + limit)}
        disabled={!hasNext}
        style={btnStyle(!hasNext)}
      >
        次へ →
      </button>
    </div>
  );
}
