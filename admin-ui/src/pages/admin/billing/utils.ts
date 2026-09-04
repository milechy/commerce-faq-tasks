import type * as React from "react";
import type { DailyUsage } from "./types";

// ─── ユーティリティ ────────────────────────────────────────
// PR-5(2026-08-25収益監査): costCalculator.ts由来のUSDセントを無変換のまま¥表示していた
// (禁止48違反)。為替換算は持ち込まず、実態通り$表示に直す。実際にStripeへ請求される
// 円建て金額(JPYはStripe上ゼロ小数通貨)は下のfmtJpyで別に表示する。
//
// S5(管理AI原価の課金・可視化): 整数丸めのみだと$1未満の原価が一律$0に潰れ、
// 「利用がある」と「利用が無い(=0)」を区別できなかった(CLAUDE.md禁止48・
// docs/ADMIN_AGENT_COST_REQUIREMENTS.md §8)。管理系の費目は数セント〜十数セント
// が常態のため、$1未満かつ0より大きい原価だけは小数第2位まで残す。$1以上の
// 既存表示(丸め)は変えない。
export function fmtCents(cents: number): string {
  if (cents > 0 && cents < 100) {
    return `$${(cents / 100).toFixed(2)}`;
  }
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** Stripeの実請求額(円)をそのまま表示する。JPYはゼロ小数通貨のため/100しない。 */
export function fmtJpy(amount: number): string {
  return `¥${Math.round(amount).toLocaleString("ja-JP")}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("ja-JP");
}

/**
 * プラン倍率の表示（`×` は呼び出し側が付ける）。
 *
 * 従来は各画面が `multiplier.toFixed(1)` を直書きしていたが、Standard(×1.25)の
 * 追加でこれが「×1.3」と誤表示になる。倍率はテナントへの請求単価そのものなので、
 * 丸めて実際と違う数字を出さない(CLAUDE.md 禁止54: 価格表記と課金実装を割らない)。
 * 既存プラン(0 / 1.0 / 1.5 / 2.5)の見た目は1桁のまま変えず、小数第2位が要る
 * 値だけ2桁にする。
 */
export function fmtPlanMultiplier(multiplier: number): string {
  return Number.isInteger(multiplier * 10) ? multiplier.toFixed(1) : multiplier.toFixed(2);
}

export function fmtDate(dateStr: string): string {
  const s = dateStr.slice(0, 10); // normalize ISO to "YYYY-MM-DD"
  const [y, m, d] = s.split("-");
  return `${y}年${m}月${d}日`;
}

/** YYYY-MM → from/to の日付範囲を返す */
export function monthToDateRange(month: string): { from: string; to: string } {
  const [year, mon] = month.split("-").map(Number);
  const from = `${year}-${String(mon).padStart(2, "0")}-01`;
  const nextMonth = mon === 12 ? new Date(year + 1, 0, 1) : new Date(year, mon, 1);
  const to = nextMonth.toISOString().slice(0, 10);
  return { from, to };
}

/** Unix timestamp (秒) → "YYYY-MM" */
export function tsToYearMonth(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ─── CSVエクスポート ───────────────────────────────────────
export function exportCsv(data: DailyUsage[], tenantName: string, month: string, header: string) {
  const rows = data.map((d) =>
    [
      d.date,
      d.requests,
      d.input_tokens,
      d.output_tokens,
      Math.round(d.cost_total_cents / 100),
    ].join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `usage_${tenantName}_${month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── スタイル定数 ─────────────────────────────────────────
export const CARD: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid var(--border)",
  background:
    "linear-gradient(145deg, var(--card), var(--card))",
  padding: "20px 18px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
};

export const BTN_LINK: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "10px 18px",
  minHeight: 44,
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--foreground)",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
};
