// admin-ui/src/pages/admin/billing/margin/MarginDrilldown.tsx
//
// 1テナントの「推計 vs Stripe実請求」突合ドリルダウン。MarginTable の行から開く。
// ★一覧では実請求を取らない(GET /v1/admin/billing/economics)★
// テナント数ぶん Stripe を叩くことになるため、突合は必ず reconcile=stripe を
// 付けたこのエンドポイントを1テナントずつ叩く。
//
// ★推計「見積り」と「実請求」を同じ語(revenue)で混ぜない★
// draft/open(未確定)の請求書では差分(variance_jpy)を出さない
// — 翌日に消える乖離を追いかけることになるため(tenantEconomics.ts の設計)。
// 該当月の請求書が無いときは「請求書なし」であって「¥0」ではない。
import { useEffect, useState } from "react";
import { API_BASE, authFetch } from "../../../../lib/api";
import { fmtCents, fmtJpy } from "../utils";
import { fmtJpyConverted, fmtJpyOrUnavailable, fmtPct, ESTIMATION_LABELS } from "./utils";
import { parseEconomicsDetailResponse } from "./economicsDetail.schema";
import type { TenantEconomicsDetailResponse } from "./economicsDetail.schema";

interface Props {
  tenantId: string;
  tenantName: string | null;
  periodYyyyMm: string;
  onClose: () => void;
}

const ROW: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline",
  padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 14,
};
const LABEL: React.CSSProperties = { color: "var(--muted-foreground)", fontSize: 13 };

function InvoiceStatusBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-block", marginLeft: 8, padding: "1px 8px", borderRadius: 999,
        fontSize: 11, fontWeight: 600, border: "1px dashed var(--border)",
        color: "var(--muted-foreground)",
      }}
    >
      {label}
    </span>
  );
}

function InvoicedSection({ data }: { data: TenantEconomicsDetailResponse }) {
  const { invoiced, variance_jpy } = data;

  if (invoiced.reason === "no_subscription_or_stripe_unavailable") {
    return <p style={{ ...LABEL, margin: "8px 0" }}>実請求と突合できません(Stripe契約情報が見つかりません)。</p>;
  }
  if (invoiced.reason === "no_invoice") {
    // ★「請求書なし」であって「¥0」ではない★
    return <p style={{ ...LABEL, margin: "8px 0" }}>この期間の請求書はありません。</p>;
  }
  if (invoiced.reason === "currency_mismatch") {
    return (
      <p style={{ ...LABEL, margin: "8px 0" }}>
        請求書は見つかりましたが円建てではないため比較できません(status: {invoiced.status})。
      </p>
    );
  }

  return (
    <>
      <div style={ROW}>
        <span style={LABEL}>
          実請求額
          {!invoiced.finalized && <InvoiceStatusBadge label="確定前" />}
        </span>
        <span style={{ fontWeight: 600 }}>
          {invoiced.amount_jpy === null ? "—" : fmtJpy(invoiced.amount_jpy)}
          {invoiced.hosted_invoice_url && (
            <>
              {" "}
              <a href={invoiced.hosted_invoice_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                請求書を見る
              </a>
            </>
          )}
        </span>
      </div>
      {invoiced.finalized ? (
        <div style={ROW}>
          <span style={LABEL}>差分(実請求 − 推計)</span>
          <span
            style={{
              fontWeight: 600,
              color: variance_jpy === null ? "var(--muted-foreground)" : variance_jpy < 0 ? "var(--destructive)" : "#4ade80",
            }}
          >
            {variance_jpy === null ? "—" : `${variance_jpy >= 0 ? "+" : ""}${fmtJpy(variance_jpy)}`}
          </span>
        </div>
      ) : (
        // ★draft/openの額では差分を出さない★ 翌日に消える乖離を追いかけない。
        <p style={{ ...LABEL, margin: "8px 0" }}>
          請求書が未確定(status: {invoiced.status})のため、差分は表示しません。
        </p>
      )}
    </>
  );
}

export function MarginDrilldown({ tenantId, tenantName, periodYyyyMm, onClose }: Props) {
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [data, setData] = useState<TenantEconomicsDetailResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setData(null);
    void (async () => {
      try {
        const res = await authFetch(
          `${API_BASE}/v1/admin/billing/economics/${encodeURIComponent(tenantId)}?period=${periodYyyyMm}&reconcile=stripe`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setStatus("error");
          return;
        }
        setData(parseEconomicsDetailResponse(await res.json()));
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, periodYyyyMm]);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={handleOverlayClick}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 20,
      }}
    >
      <div
        style={{
          background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16,
          padding: "24px 24px", maxWidth: 520, width: "100%", maxHeight: "85vh", overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
            {tenantName ?? tenantId}
          </h2>
          <button
            onClick={onClose}
            aria-label="閉じる"
            style={{
              background: "transparent", border: "none", color: "var(--muted-foreground)",
              fontSize: 20, cursor: "pointer", lineHeight: 1, padding: 4, minHeight: 32,
            }}
          >
            ×
          </button>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted-foreground)" }}>
          推計(DB利用実績)と Stripe 実請求の突合 — {periodYyyyMm}
        </p>

        {status === "loading" && <p style={{ ...LABEL, margin: 0 }}>読み込み中…</p>}
        {status === "error" && (
          <p style={{ margin: 0, fontSize: 14, color: "var(--destructive)" }}>
            取得に失敗しました。もう一度お試しください。
          </p>
        )}

        {status === "ready" && data && (
          <>
            <div style={ROW}>
              <span style={LABEL}>プラン</span>
              <span>{data.row.plan ?? "未設定"}</span>
            </div>
            <div style={ROW}>
              <span style={LABEL}>売上(推計)</span>
              <span style={{ fontWeight: 600 }}>{fmtJpyOrUnavailable(data.row.revenue_estimate_jpy)}</span>
            </div>
            <div style={ROW}>
              <span style={LABEL}>API原価</span>
              <span>
                {fmtCents(data.row.cost_base_usd_cents)}
                {" "}
                <span style={{ color: "var(--muted-foreground)" }}>({fmtJpyConverted(data.row.cost_base_jpy)})</span>
              </span>
            </div>
            <div style={ROW}>
              <span style={LABEL}>粗利(推計) / 粗利率</span>
              <span style={{ fontWeight: 600 }}>
                {fmtJpyOrUnavailable(data.row.gross_profit_jpy)}（{fmtPct(data.row.gross_margin_pct)}）
              </span>
            </div>
            <div style={ROW}>
              <span style={LABEL}>原価の確度</span>
              <span>{ESTIMATION_LABELS[data.row.estimation_method]}</span>
            </div>

            <h3 style={{ fontSize: 13, fontWeight: 600, margin: "16px 0 4px", color: "var(--muted-foreground)" }}>
              Stripe 実請求との突合
            </h3>
            <InvoicedSection data={data} />

            <p style={{ margin: "16px 0 0", fontSize: 11, color: "var(--muted-foreground)", lineHeight: 1.6 }}>
              ※ 売上は推計です。締め日・日割り・請求調整・無料期間により実請求とは差が出ます。
              ※ 固定費(アバター基盤・VPS等)の按分は含みません。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
