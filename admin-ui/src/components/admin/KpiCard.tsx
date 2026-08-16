export interface KpiCardProps {
  name: string;
  value: string | number;
  unit?: string;
  threshold: string;
  met: boolean;
  description?: string;
}

export default function KpiCard({
  name,
  value,
  unit,
  threshold,
  met,
  description,
}: KpiCardProps) {
  return (
    <div
      style={{
        flex: "1 1 260px",
        borderRadius: 14,
        border: met ? "1px solid #1f2937" : "1px solid var(--destructive-border)",
        background: met
          ? "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))"
          : "var(--destructive-surface)",
        padding: "20px 18px",
        minHeight: 56,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: met
          ? "0 4px 16px rgba(0,0,0,0.2)"
          : "0 4px 20px rgba(239,68,68,0.15)",
        transition: "all 0.2s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: met ? "#9ca3af" : "var(--destructive)",
            lineHeight: 1.3,
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            padding: "3px 10px",
            borderRadius: 999,
            background: met ? "rgba(34,197,94,0.15)" : "var(--destructive-border)",
            color: met ? "#4ade80" : "var(--destructive)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {met ? "達成" : "未達成"}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 4,
          marginTop: 2,
        }}
      >
        <span
          style={{
            fontSize: 32,
            fontWeight: 700,
            color: met ? "#f9fafb" : "var(--destructive)",
            lineHeight: 1,
          }}
        >
          {value}
        </span>
        {unit && (
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: met ? "#9ca3af" : "var(--destructive)",
            }}
          >
            {unit}
          </span>
        )}
      </div>

      <div
        style={{
          fontSize: 12,
          color: met ? "#6b7280" : "var(--destructive)",
          marginTop: 2,
        }}
      >
        SLA目標: {threshold}
      </div>

      {description && (
        <div
          style={{
            fontSize: 12,
            color: met ? "#6b7280" : "var(--destructive)",
            opacity: met ? 0.8 : 0.9,
          }}
        >
          {description}
        </div>
      )}
    </div>
  );
}
