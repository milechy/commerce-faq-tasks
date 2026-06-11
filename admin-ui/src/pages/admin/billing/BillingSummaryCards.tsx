import type { ReactNode } from "react";
import type { TranslationKey } from "../../../i18n/ja";
import type { BillingSummary } from "./types";
import { fmtCents, fmtNum, CARD } from "./utils";

interface BillingSummaryCardsProps {
  summaryTitle: string;
  summary: BillingSummary;
  statusBadge: (status: BillingSummary["billing_status"]) => ReactNode;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

export function BillingSummaryCards({ summaryTitle, summary, statusBadge, t }: BillingSummaryCardsProps) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 12 }}>
        {summaryTitle}
      </h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {/* リクエスト数 */}
        <div style={{ ...CARD, flex: "1 1 140px" }}>
          <div style={{ fontSize: 26, marginBottom: 4 }}>📊</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "var(--foreground)", lineHeight: 1 }}>
            {fmtNum(summary.total_requests)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)", marginTop: 4 }}>
            {t("billing.total_requests")}
          </div>
        </div>

        {/* AI処理量 */}
        <div style={{ ...CARD, flex: "1 1 140px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 26 }}>🤖</span>
            <span
              title="AIが文章を読み書きした量です"
              style={{ fontSize: 13, color: "var(--muted-foreground)", cursor: "help" }}
            >
              (?)
            </span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#a78bfa", lineHeight: 1 }}>
            {fmtNum(summary.total_input_tokens + summary.total_output_tokens)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)", marginTop: 4 }}>
            AIの処理量
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 2 }}>
            AIが文章を読み書きした量
          </div>
        </div>

        {/* LLMコスト（原価） */}
        <div style={{ ...CARD, flex: "1 1 140px" }}>
          <div style={{ fontSize: 26, marginBottom: 4 }}>💹</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#60a5fa", lineHeight: 1 }}>
            {fmtCents(summary.cost_llm_cents)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)", marginTop: 4 }}>
            {t("billing.ai_cost")}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 2 }}>
            {t("billing.ai_cost_sub")}
          </div>
        </div>

        {/* 請求額 */}
        <div style={{ ...CARD, flex: "1 1 140px" }}>
          <div style={{ fontSize: 26, marginBottom: 4 }}>🧾</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#4ade80", lineHeight: 1 }}>
            {fmtCents(summary.cost_total_cents)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)", marginTop: 4 }}>
            {t("billing.total_amount")}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 2 }}>
            {t("billing.total_amount_sub")}
          </div>
        </div>

        {/* お支払い状況 */}
        <div style={{ ...CARD, flex: "1 1 140px" }}>
          <div style={{ fontSize: 26, marginBottom: 4 }}>💳</div>
          <div style={{ marginTop: 4 }}>
            {statusBadge(summary.billing_status)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)", marginTop: 8 }}>
            {t("billing.payment_status")}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 2 }}>
            {t("billing.payment_status_sub")}
          </div>
        </div>
      </div>
    </section>
  );
}
