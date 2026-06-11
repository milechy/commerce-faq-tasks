import type { TabId } from "./types";

// ─── タブナビゲーション ───────────────────────────────────────────────────────

export function TenantDetailTabs({
  TABS,
  activeTab,
  setActiveTab,
}: {
  TABS: { id: TabId; label: React.ReactNode }[];
  activeTab: TabId;
  setActiveTab: React.Dispatch<React.SetStateAction<TabId>>;
}) {
  return (
    <div
      style={{
        overflowX: "auto",
        marginBottom: 24,
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 4,
        WebkitOverflowScrolling: "touch" as const,
      }}
    >
      <div style={{ display: "flex", gap: 4, minWidth: "max-content" }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "12px 16px",
              minHeight: 44,
              whiteSpace: "nowrap",
              borderRadius: 10,
              border: "none",
              background: activeTab === tab.id ? "rgba(34,197,94,0.15)" : "transparent",
              color: activeTab === tab.id ? "#4ade80" : "#9ca3af",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
