import type { OutcomeScore } from "./types";

export function OutcomeScoreChart({ data }: { data: OutcomeScore[] }) {
  const max = Math.max(...data.map((d) => d.avg_score), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {data.map((item) => (
        <div key={item.outcome} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, color: "#e5e7eb", fontWeight: 600 }}>{item.label}</span>
            <span style={{ fontSize: 14, color: "#9ca3af" }}>{item.avg_score}</span>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 4, height: 10, overflow: "hidden" }}>
            <div
              style={{
                width: `${(item.avg_score / max) * 100}%`,
                height: "100%",
                background:
                  item.outcome === "appointment"
                    ? "linear-gradient(90deg, #22c55e, #4ade80)"
                    : item.outcome === "lost"
                    ? "linear-gradient(90deg, #dc2626, #f87171)"
                    : "linear-gradient(90deg, #2563eb, #60a5fa)",
                borderRadius: 4,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
