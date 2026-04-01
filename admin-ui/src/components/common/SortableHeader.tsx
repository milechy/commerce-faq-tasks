// admin-ui/src/components/common/SortableHeader.tsx
// Phase52b: ソート可能なカラムヘッダ共通コンポーネント

interface SortableHeaderProps {
  label: string;
  sortKey: string;
  currentSortBy: string;
  currentSortOrder: "asc" | "desc";
  onSort: (sortKey: string) => void;
}

export function SortableHeader({
  label,
  sortKey,
  currentSortBy,
  currentSortOrder,
  onSort,
}: SortableHeaderProps) {
  const isActive = currentSortBy === sortKey;
  return (
    <button
      onClick={() => onSort(sortKey)}
      style={{
        background: "none",
        border: "none",
        color: isActive ? "#f9fafb" : "#9ca3af",
        fontSize: 13,
        fontWeight: isActive ? 700 : 400,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 0",
        whiteSpace: "nowrap",
      }}
    >
      {label}
      <span style={{ fontSize: 10, opacity: isActive ? 1 : 0.4 }}>
        {isActive ? (currentSortOrder === "asc" ? "▲" : "▼") : "▼"}
      </span>
    </button>
  );
}
