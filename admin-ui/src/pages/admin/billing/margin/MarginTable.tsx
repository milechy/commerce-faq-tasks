// admin-ui/src/pages/admin/billing/margin/MarginTable.tsx
//
// テナント別の採算表。★純プレゼンテーション(props のみ・fetch しない)★
// BillingMainContent.tsx と同じ作法で、state を持つのは index.tsx 側。
//
// ★super_admin 専用★ 原価とマージン倍率を同時に描画するため、
// テナントに見える面から import しないこと。
import { SortableHeader } from "../../../../components/common/SortableHeader";
import { CARD, fmtCents, fmtNum } from "../utils";
import {
  ESTIMATION_LABELS, fmtJpyConverted, fmtJpyOrUnavailable, fmtPct,
  type MarginSortKey,
} from "./utils";
import type { TenantMarginRow } from "./types";

const TH: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--muted-foreground)",
  whiteSpace: "nowrap",
};
const TD: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--foreground)",
  whiteSpace: "nowrap",
};

/** 「推計」であることを行ごとに示すチップ。色だけで区別しない(必ず文字を入れる)。 */
function EstimationChip({ row }: { row: TenantMarginRow }) {
  const label = ESTIMATION_LABELS[row.estimation_method];
  const isExact = row.estimation_method === "recorded";
  return (
    <span
      title={
        isExact
          ? "全ての行に実原価が記録されています"
          : `原価の一部を cost_total_cents から逆算しています（実測 ${Math.round(row.recorded_row_ratio * 100)}%）`
      }
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        border: isExact ? "1px solid var(--border)" : "1px dashed var(--border)",
        color: isExact ? "var(--foreground)" : "var(--muted-foreground)",
      }}
    >
      {label}
    </span>
  );
}

export interface MarginTableProps {
  rows: TenantMarginRow[];
  sortBy: MarginSortKey;
  sortOrder: "asc" | "desc";
  onSort: (key: string) => void;
  /** 原価の円換算に使ったレート。列見出しに出して概算だと分かるようにする。 */
  usdJpy: number;
  /** テナント名クリックで Stripe 実請求とのドリルダウンを開く。 */
  onDrilldown: (tenantId: string, tenantName: string | null) => void;
}

export function MarginTable({ rows, sortBy, sortOrder, onSort, usdJpy, onDrilldown }: MarginTableProps) {
  if (rows.length === 0) {
    return (
      <section style={{ ...CARD }}>
        <p style={{ margin: 0, color: "var(--muted-foreground)", fontSize: 14 }}>
          この月に利用のあったテナントはありません。
        </p>
      </section>
    );
  }

  const col = (label: string, key: MarginSortKey) => (
    <th style={TH}>
      <SortableHeader
        label={label}
        sortKey={key}
        currentSortBy={sortBy}
        currentSortOrder={sortOrder}
        onSort={onSort}
      />
    </th>
  );

  return (
    <section style={{ ...CARD }}>
      {/* 390px でも本文が横に溢れないよう、表だけを横スクロールさせる */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 900 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {col("テナント", "tenant")}
              {col("プラン", "plan")}
              {col("リクエスト", "requests")}
              <th style={TH}>会話数</th>
              {col("売上(推計)", "revenue")}
              {col("API原価", "cost")}
              <th style={TH}>API原価(≈¥ /{usdJpy})</th>
              {col("粗利(推計)", "profit")}
              {col("粗利率", "margin")}
              <th style={TH}>原価の確度</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tenant_id} style={{ borderBottom: "1px solid rgba(31,41,55,0.5)" }}>
                <td style={TD}>
                  <button
                    onClick={() => onDrilldown(r.tenant_id, r.tenant_name)}
                    style={{
                      background: "transparent", border: "none", padding: 0,
                      color: "#60a5fa", fontWeight: 600, fontSize: 14, cursor: "pointer",
                      textDecoration: "underline", textUnderlineOffset: 3,
                    }}
                    title="Stripe実請求との突合を見る"
                  >
                    {r.tenant_name ?? r.tenant_id}
                  </button>
                </td>
                <td style={TD}>{r.plan ?? "未設定"}</td>
                <td style={TD}>{fmtNum(r.total_requests)}</td>
                <td style={TD}>{r.text_units === null ? "—" : fmtNum(r.text_units)}</td>
                {/* ★算出不可は「算出不可」であって「¥0」ではない★ */}
                <td style={TD}>{fmtJpyOrUnavailable(r.revenue_estimate_jpy)}</td>
                {/* 原価は USD セント。売上(¥)と単位を取り違えないよう $ で出す */}
                <td style={TD}>{fmtCents(r.cost_base_usd_cents)}</td>
                <td style={{ ...TD, color: "var(--muted-foreground)" }}>
                  {fmtJpyConverted(r.cost_base_jpy)}
                </td>
                <td
                  style={{
                    ...TD,
                    fontWeight: 600,
                    color:
                      r.gross_profit_jpy === null
                        ? "var(--muted-foreground)"
                        : r.gross_profit_jpy < 0
                          ? "var(--destructive)"
                          : "#4ade80",
                  }}
                >
                  {fmtJpyOrUnavailable(r.gross_profit_jpy)}
                </td>
                <td style={TD}>{fmtPct(r.gross_margin_pct)}</td>
                <td style={TD}><EstimationChip row={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ★固定費を含まないことを常時出す★ 「粗利」の語だけを見て営業利益と読ませない */}
      <p style={{ margin: "14px 0 0", fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
        ※ 売上は「推計」です（DBの利用実績 × Stripe価格表）。締め日・日割り・請求調整・無料期間により、
        Stripeの実請求額とは差が出ます。<br />
        ※ 粗利は変動費（API原価）のみを引いた額です。<strong>固定費（アバター基盤・VPS等）の按分は含みません。</strong><br />
        ※ API原価の円換算は 1 USD = {usdJpy} 円の固定レートによる概算です（実際の為替・約定レートではありません）。
      </p>
    </section>
  );
}
