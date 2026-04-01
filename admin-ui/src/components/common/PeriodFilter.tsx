// admin-ui/src/components/common/PeriodFilter.tsx
// Phase52b: 期間フィルタ共通コンポーネント

const PERIODS = [
  { value: "7", label: "7日" },
  { value: "30", label: "30日" },
  { value: "90", label: "90日" },
  { value: "all", label: "全期間" },
] as const;

export type PeriodValue = "7" | "30" | "90" | "all";

interface PeriodFilterProps {
  value: PeriodValue;
  onChange: (value: PeriodValue) => void;
}

export function PeriodFilter({ value, onChange }: PeriodFilterProps) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <span style={{ fontSize: 12, color: "#6b7280", marginRight: 4, whiteSpace: "nowrap" }}>期間:</span>
      {PERIODS.map((p) => {
        const isActive = value === p.value;
        return (
          <button
            key={p.value}
            onClick={() => onChange(p.value)}
            style={{
              padding: "6px 12px",
              minHeight: 32,
              borderRadius: 8,
              border: `1px solid ${isActive ? "rgba(96,165,250,0.5)" : "#374151"}`,
              background: isActive ? "rgba(96,165,250,0.12)" : "transparent",
              color: isActive ? "#60a5fa" : "#9ca3af",
              fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
