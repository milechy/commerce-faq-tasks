// admin-ui/src/pages/admin/billing/margin/utils.ts
//
// 粗利画面の整形とCSV。★super_admin 専用★
// CARD / BTN_LINK / fmtCents / fmtJpy / fmtNum は ../utils から import する
// (再実装しない。単位ごとの整形関数を2組持つと必ずどちらかで取り違える)。
import type { TenantMarginRow, EstimationMethod } from "./types";

/**
 * 為替換算した円。★実額の円(fmtJpy)と別の関数にする★
 *
 * 原価は USD セントで記録されており、円表示は固定レートによる概算にすぎない。
 * Stripe の実請求額(fmtJpy)と同じ「¥」で並べると、どちらが実額か区別できなくなる。
 * 近似記号を付けて、見た目で違うと分かるようにする(禁止48: 整形関数も単位ごとに分ける)。
 */
export function fmtJpyConverted(amount: number | null): string {
  if (amount === null) return "—";
  return `≈¥${Math.round(amount).toLocaleString("ja-JP")}`;
}

/** 粗利率。算出不可は「—」(0% と区別する)。 */
export function fmtPct(pct: number | null): string {
  return pct === null ? "—" : `${pct}%`;
}

/**
 * 売上・粗利の表示。★null を ¥0 にしない★
 * enterprise / Stripe未設定は「算出不可」であって「0円」ではない(禁止20)。
 */
export function fmtJpyOrUnavailable(amount: number | null): string {
  if (amount === null) return "算出不可";
  return `¥${Math.round(amount).toLocaleString("ja-JP")}`;
}

/** 込み枠の消化率。込み枠の無いプランは「枠なし」(0% と区別する)。 */
export function fmtQuotaUsage(pct: number | null): string {
  return pct === null ? "枠なし" : `${pct}%`;
}

/** 原価の確からしさのラベル。移行期であることを画面に出す。 */
export const ESTIMATION_LABELS: Record<EstimationMethod, string> = {
  recorded: "実測",
  derived: "推計",
  mixed: "一部推計",
};

/** 直近 N ヶ月の "YYYY-MM" を新しい順で返す(月セレクタ用)。 */
export function recentMonths(count: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** "YYYY-MM" → API が受ける "YYYYMM"。 */
export function monthToPeriod(month: string): string {
  return month.replace("-", "");
}

export type MarginSortKey =
  | "tenant" | "plan" | "requests" | "revenue" | "cost" | "profit" | "margin";

/**
 * ソート。★既定は粗利率の昇順(採算の悪い順)★
 * 手を打つ相手が上に来る並びにする。
 * null は「算出不可」なので、昇順でも降順でも常に末尾へ送る
 * (0 として最上位に並べると「最も採算が悪い」と誤読される)。
 */
export function sortMarginRows(
  rows: TenantMarginRow[], key: MarginSortKey, order: "asc" | "desc",
): TenantMarginRow[] {
  const dir = order === "asc" ? 1 : -1;
  const val = (r: TenantMarginRow): number | string | null => {
    switch (key) {
      case "tenant": return r.tenant_name ?? r.tenant_id;
      case "plan": return r.plan ?? "";
      case "requests": return r.total_requests;
      case "revenue": return r.revenue_estimate_jpy;
      case "cost": return r.cost_base_usd_cents;
      case "profit": return r.gross_profit_jpy;
      case "margin": return r.gross_margin_pct;
    }
  };
  return [...rows].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    // null(算出不可)は並び順に関わらず常に末尾
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv), "ja") * dir;
    }
    return (av - bv) * dir;
  });
}

/**
 * CSV 出力。営業リストとして社外の目にも触れうるので、
 * 列名に単位と「推計かどうか」を埋める(見出しだけで意味が閉じるようにする)。
 */
export function exportMarginCsv(rows: TenantMarginRow[], month: string, usdJpy: number) {
  const header = [
    "テナントID", "テナント名", "プラン", "リクエスト数", "会話数",
    "売上_推計_JPY", "API原価_USD", `API原価_円換算_JPY_レート${usdJpy}`,
    "粗利_推計_JPY", "粗利率_%", "原価の確からしさ", "非課金原価_USD",
  ].join(",");

  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const body = rows.map((r) =>
    [
      esc(r.tenant_id),
      esc(r.tenant_name ?? ""),
      esc(r.plan ?? ""),
      String(r.total_requests),
      r.text_units === null ? "" : String(r.text_units),
      // ★空欄と 0 を区別する★ 算出不可は空欄にして 0 と読ませない
      r.revenue_estimate_jpy === null ? "" : String(r.revenue_estimate_jpy),
      (r.cost_base_usd_cents / 100).toFixed(2),
      r.cost_base_jpy === null ? "" : String(r.cost_base_jpy),
      r.gross_profit_jpy === null ? "" : String(r.gross_profit_jpy),
      r.gross_margin_pct === null ? "" : String(r.gross_margin_pct),
      ESTIMATION_LABELS[r.estimation_method],
      (r.cost_nonbillable_usd_cents / 100).toFixed(2),
    ].join(","),
  );

  const csv = [header, ...body].join("\n");
  // BOM 付き(既存 exportCsv と同じ。Excel で文字化けさせない)
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `margin_${month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
