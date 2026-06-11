import UsageChart from "../../../components/UsageChart";
import type { TranslationKey } from "../../../i18n/ja";
import type { DailyUsage } from "./types";
import { CARD } from "./utils";

interface UsageChartSectionProps {
  daily: DailyUsage[];
  chartMode: "requests" | "cost";
  setChartMode: (mode: "requests" | "cost") => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

export function UsageChartSection({ daily, chartMode, setChartMode, t }: UsageChartSectionProps) {
  return (
    <section style={{ ...CARD, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: 0 }}>
          {t("billing.chart_title")}
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setChartMode("requests")}
            style={{
              padding: "6px 14px",
              minHeight: 36,
              borderRadius: 8,
              border: "none",
              background: chartMode === "requests" ? "#22c55e" : "rgba(255,255,255,0.05)",
              color: chartMode === "requests" ? "#022c22" : "#9ca3af",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("billing.requests")}
          </button>
          <button
            onClick={() => setChartMode("cost")}
            style={{
              padding: "6px 14px",
              minHeight: 36,
              borderRadius: 8,
              border: "none",
              background: chartMode === "cost" ? "#22c55e" : "rgba(255,255,255,0.05)",
              color: chartMode === "cost" ? "#022c22" : "#9ca3af",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("billing.cost")}
          </button>
        </div>
      </div>
      <UsageChart data={daily} mode={chartMode} />
    </section>
  );
}
