import { useLang } from "../../i18n/LangContext";

interface BulkActionBarProps {
  selectedCount: number;
  onBulkDelete: () => void;
  onClearSelection: () => void;
  loading: boolean;
}

export default function BulkActionBar({
  selectedCount,
  onBulkDelete,
  onClearSelection,
  loading,
}: BulkActionBarProps) {
  const { t } = useLang();

  if (selectedCount === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        background: "rgba(9,17,31,0.97)",
        borderTop: "1px solid #1f2937",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        boxShadow: "0 -8px 32px rgba(0,0,0,0.6)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb" }}>
          {t("knowledge.selected_count", { n: selectedCount })}
        </span>
        <button
          onClick={onClearSelection}
          style={{
            padding: "8px 14px",
            minHeight: 36,
            borderRadius: 8,
            border: "1px solid #374151",
            background: "transparent",
            color: "#9ca3af",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {t("knowledge.clear_selection")}
        </button>
      </div>
      <button
        onClick={onBulkDelete}
        disabled={loading}
        style={{
          padding: "12px 28px",
          minHeight: 48,
          borderRadius: 10,
          border: "none",
          background: loading
            ? "rgba(127,29,29,0.4)"
            : "linear-gradient(135deg, #991b1b, #dc2626)",
          color: "#fee2e2",
          fontSize: 15,
          fontWeight: 700,
          cursor: loading ? "not-allowed" : "pointer",
        }}
      >
        {loading
          ? t("common.deleting")
          : t("knowledge.bulk_delete", { n: selectedCount })}
      </button>
    </div>
  );
}
