import type * as React from "react";
import type { DailyUsage } from "./types";

// ─── ユーティリティ ────────────────────────────────────────
export function fmtCents(cents: number): string {
  return `¥${Math.round(cents / 100).toLocaleString("ja-JP")}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("ja-JP");
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
