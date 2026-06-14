import type { PsychPrinciple } from "./types";

export function PsychPrincipleList({ principles }: { principles: PsychPrinciple[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {principles.map((p, i) => (
        <div key={p.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, color: "#e5e7eb", fontWeight: 600 }}>
              {i + 1}. {p.name}
            </span>
            <span style={{ fontSize: 12, color: "#9ca3af" }}>{p.usage_count}回 / 効果率 {Math.round(p.effectiveness_rate * 100)}%</span>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 4, height: 8, overflow: "hidden" }}>
            <div
              style={{
                width: `${p.effectiveness_rate * 100}%`,
                height: "100%",
                background: "linear-gradient(90deg, #22c55e, #4ade80)",
                borderRadius: 4,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
