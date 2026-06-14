import { CARD } from "./styles";
import type { KpiSummary } from "./types";

export function KpiCards({ kpi }: { kpi: KpiSummary }) {
  const items = [
    { label: "返信率", value: kpi.reply_rate, delta: kpi.reply_rate_delta },
    { label: "アポ率", value: kpi.appointment_rate, delta: kpi.appointment_rate_delta },
    { label: "失注率", value: kpi.lost_rate, delta: kpi.lost_rate_delta },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
      {items.map((item) => (
        <div key={item.label} style={{ ...CARD, textAlign: "center" as const }}>
          <p style={{ margin: "0 0 6px", fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>{item.label}</p>
          <p style={{ margin: "0 0 6px", fontSize: 26, fontWeight: 700, color: "#f9fafb" }}>
            {Math.round(item.value * 100)}%
          </p>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 600,
              color:
                item.label === "失注率"
                  ? item.delta < 0 ? "#4ade80" : "#f87171"
                  : item.delta >= 0 ? "#4ade80" : "#f87171",
            }}
          >
            {item.delta >= 0 ? "+" : ""}
            {Math.round(item.delta * 100)}% 先週比
          </p>
        </div>
      ))}
    </div>
  );
}
