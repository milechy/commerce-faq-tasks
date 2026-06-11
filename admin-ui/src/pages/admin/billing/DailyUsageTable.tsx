import type { TranslationKey } from "../../../i18n/ja";
import type { BillingSummary, DailyUsage } from "./types";
import { fmtCents, fmtNum, fmtDate, CARD, BTN_LINK } from "./utils";

interface DailyUsageTableProps {
  daily: DailyUsage[];
  summary: BillingSummary;
  onCsvDownload: () => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

export function DailyUsageTable({ daily, summary, onCsvDownload, t }: DailyUsageTableProps) {
  return (
    <section style={{ ...CARD, marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: 0 }}>
          {t("billing.daily_title")}
        </h2>
        <button
          onClick={onCsvDownload}
          style={{
            ...BTN_LINK,
            fontSize: 14,
            padding: "8px 16px",
            minHeight: 44,
          }}
        >
          {t("billing.csv_download")}
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 480 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {[t("billing.col_date"), t("billing.col_requests"), t("billing.col_cost")].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "10px 12px",
                    textAlign: "left",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--muted-foreground)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {daily.map((d) => (
              <tr
                key={d.date}
                style={{ borderBottom: "1px solid rgba(31,41,55,0.5)" }}
              >
                <td style={{ padding: "10px 12px", color: "var(--muted-foreground)" }}>{fmtDate(d.date)}</td>
                <td style={{ padding: "10px 12px", color: "var(--foreground)", fontWeight: 600 }}>
                  {fmtNum(d.requests)}
                </td>
                <td style={{ padding: "10px 12px", color: "#4ade80", fontWeight: 600 }}>
                  {fmtCents(d.cost_total_cents)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "12px", fontWeight: 700, color: "var(--foreground)" }}>{t("billing.total")}</td>
              <td style={{ padding: "12px", fontWeight: 700, color: "var(--foreground)" }}>
                {fmtNum(summary.total_requests)}
              </td>
              <td style={{ padding: "12px", fontWeight: 700, color: "#4ade80" }}>
                {fmtCents(summary.cost_total_cents)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
