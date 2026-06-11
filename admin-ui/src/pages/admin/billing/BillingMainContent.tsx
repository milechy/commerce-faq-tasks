import type { ReactNode } from "react";
import type { TranslationKey } from "../../../i18n/ja";
import type { BillingAdjustment, BillingSummary, CrossTenantRow, DailyUsage, Invoice } from "./types";
import { fmtCents, fmtNum, CARD, BTN_LINK } from "./utils";

interface BillingMainContentProps {
  daily: DailyUsage[];
  summary: BillingSummary;
  invoices: Invoice[];
  isSuperAdmin: boolean;
  retryLoadingId: string | null;
  handleRetryInvoice: (invoiceId: string) => Promise<void>;
  invoiceStatusBadge: (status: Invoice["status"]) => ReactNode;
  adjustments: BillingAdjustment[];
  crossTenantRows: CrossTenantRow[];
  setSelectedTenantId: (tenantId: string) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

export function BillingMainContent({
  daily,
  summary,
  invoices,
  isSuperAdmin,
  retryLoadingId,
  handleRetryInvoice,
  invoiceStatusBadge,
  adjustments,
  crossTenantRows,
  setSelectedTenantId,
  t,
}: BillingMainContentProps) {
  return (
    <>
      {/* データなし */}
      {daily.length === 0 && summary.total_requests === 0 && (
        <section style={{ ...CARD, marginBottom: 20, textAlign: "center", padding: "32px 20px" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
          <div style={{ fontSize: 15, color: "var(--muted-foreground)" }}>{t("billing.no_data")}</div>
        </section>
      )}

      {/* 請求履歴 */}
      <section style={{ ...CARD, marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 16, margin: "0 0 16px" }}>
          {t("billing.invoice_title")}
        </h2>

        {invoices.length === 0 ? (
          <div style={{ textAlign: "center", padding: "24px", color: "var(--muted-foreground)", fontSize: 14 }}>
            {t("billing.invoice_empty")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {invoices.map((inv) => {
              const [year, mon] = inv.month.split("-");
              const monthLabel = `${year}/${mon}`;
              return (
                <div
                  key={inv.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "14px 16px",
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "rgba(0,0,0,0.2)",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "var(--foreground)" }}>
                      {t("billing.invoice_month", { month: monthLabel })}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 2 }}>
                      {t("billing.invoice_amount", { amount: fmtCents(inv.amount_cents) })} &nbsp;|&nbsp;{" "}
                      {invoiceStatusBadge(inv.status)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {inv.hosted_invoice_url && (
                      <a
                        href={inv.hosted_invoice_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          ...BTN_LINK,
                          fontSize: 13,
                          padding: "8px 14px",
                          borderColor: "#22c55e",
                          color: "#4ade80",
                        }}
                      >
                        {t("billing.view_detail")}
                      </a>
                    )}
                    {inv.invoice_pdf && (
                      <a
                        href={inv.invoice_pdf}
                        target="_blank"
                        rel="noopener noreferrer"
                        download
                        style={{
                          ...BTN_LINK,
                          fontSize: 13,
                          padding: "8px 14px",
                          borderColor: "#374151",
                          color: "var(--muted-foreground)",
                        }}
                      >
                        📥 PDF
                      </a>
                    )}
                    {isSuperAdmin && inv.status === "open" && (
                      <button
                        onClick={() => void handleRetryInvoice(inv.id)}
                        disabled={retryLoadingId === inv.id}
                        style={{
                          ...BTN_LINK,
                          fontSize: 13,
                          padding: "8px 14px",
                          borderColor: "rgba(234,179,8,0.5)",
                          color: "#fbbf24",
                          opacity: retryLoadingId === inv.id ? 0.6 : 1,
                          cursor: retryLoadingId === inv.id ? "not-allowed" : "pointer",
                        }}
                      >
                        {retryLoadingId === inv.id ? "処理中..." : "🔄 再請求"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {/* Super Admin: 金額調整履歴 */}
      {isSuperAdmin && adjustments.length > 0 && (
        <section style={{ ...CARD, marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px" }}>
            💰 金額調整履歴
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {adjustments.map((adj) => (
              <div
                key={adj.id}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 16px", borderRadius: 10,
                  border: "1px solid var(--border)", background: "rgba(0,0,0,0.2)",
                  flexWrap: "wrap", gap: 8,
                }}
              >
                <div>
                  <span style={{
                    fontSize: 15, fontWeight: 700,
                    color: adj.amount < 0 ? "#a78bfa" : "#f87171",
                  }}>
                    {adj.amount < 0
                      ? `▼ ¥${Math.abs(adj.amount).toLocaleString("ja-JP")} 割引`
                      : `▲ ¥${adj.amount.toLocaleString("ja-JP")} 追加`}
                  </span>
                  <div style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 2 }}>{adj.reason}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{adj.adjusted_by}</div>
                  <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                    {new Date(adj.created_at).toLocaleDateString("ja-JP")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Super Admin: テナント横断利用状況 */}
      {isSuperAdmin && crossTenantRows.length > 0 && (
        <section style={{ ...CARD, marginBottom: 32 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 16px" }}>
            テナント別利用状況（今月）
          </h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 400 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["テナントID", "リクエスト数", "今月のご利用額"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "10px 12px",
                        textAlign: "left",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--muted-foreground)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {crossTenantRows.map((row) => (
                  <tr
                    key={row.tenant_id}
                    style={{ borderBottom: "1px solid rgba(31,41,55,0.5)", cursor: "pointer" }}
                    onClick={() => setSelectedTenantId(row.tenant_id)}
                  >
                    <td style={{ padding: "10px 12px", color: "#60a5fa", fontWeight: 600 }}>
                      {row.tenant_id}
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--foreground)" }}>
                      {fmtNum(row.total_requests)}
                    </td>
                    <td style={{ padding: "10px 12px", color: "#4ade80", fontWeight: 600 }}>
                      {fmtCents(row.cost_total_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
