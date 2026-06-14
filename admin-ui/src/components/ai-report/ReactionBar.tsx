import type { CustomerReaction } from "./types";

export function ReactionBar({ reactions }: { reactions: CustomerReaction }) {
  const total = reactions.positive + reactions.neutral + reactions.negative || 1;
  const items = [
    { label: "肯定的", value: reactions.positive, color: "#4ade80" },
    { label: "中立", value: reactions.neutral, color: "#fbbf24" },
    { label: "否定的", value: reactions.negative, color: "#f87171" },
    ...(reactions.unknown ? [{ label: "不明", value: reactions.unknown, color: "#6b7280" }] : []),
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", height: 24, borderRadius: 6, overflow: "hidden", gap: 2 }}>
        {items.map((item) => (
          <div
            key={item.label}
            style={{
              flex: item.value / total,
              background: item.color,
              opacity: 0.85,
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" as const }}>
        {items.map((item) => (
          <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: item.color }} />
            <span style={{ fontSize: 13, color: "#9ca3af" }}>
              {item.label}: {Math.round((item.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
