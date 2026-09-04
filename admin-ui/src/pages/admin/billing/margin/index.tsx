// admin-ui/src/pages/admin/billing/margin/index.tsx
//
// テナント別の採算（売上推計 − API原価）。★super_admin 専用★
//
// ■ なぜ /admin/analytics ではなく /admin/billing 配下か
// 原価開示方針 H-10(src/lib/billing/costCalculator.ts)は「課金画面は原価を出す /
// analytics 系の原価は super_admin 限定」。この画面は原価と請求額を同一画面で
// 扱うので課金画面の系譜。単位規約(fmtCents=$ / fmtJpy=¥)も ../utils に閉じており、
// 隣接ディレクトリなら整形関数をもう1組作らずに済む。
//
// ■ 既存 /admin/billing との役割分担
//   /admin/billing        … 1テナントの請求確認と請求操作(両ロール・書き込みあり)
//   /admin/billing/margin … 全テナント横断の採算判断(super_admin のみ・読み取り専用)
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, authFetch } from "../../../../lib/api";
import { supabase } from "../../../../lib/supabaseClient";
import { LoadErrorBanner } from "../../../../components/common/LoadErrorBanner";
import { CARD, BTN_LINK } from "../utils";
import { MarginTable } from "./MarginTable";
import { UpsellProposalsSection } from "./UpsellProposalsSection";
import { parseMarginSummaryResponse } from "./marginSummary.schema";
import {
  exportMarginCsv, monthToPeriod, recentMonths, sortMarginRows,
  type MarginSortKey,
} from "./utils";
import type { MarginSummaryResponse } from "./types";

const SORT_KEYS: readonly MarginSortKey[] = [
  "tenant", "plan", "requests", "revenue", "cost", "profit", "margin",
];

export default function MarginDashboardPage() {
  const navigate = useNavigate();

  const months = recentMonths(12);
  const [month, setMonth] = useState<string>(months[0]!);
  const [data, setData] = useState<MarginSummaryResponse | null>(null);
  // billing 画面と同じ3状態。無限スピナーを残さない。
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  // ★既定は粗利率の昇順(採算の悪い順)★ 手を打つ相手が上に来る。
  const [sortBy, setSortBy] = useState<MarginSortKey>("margin");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  const load = useCallback(async () => {
    setStatus("loading");
    setErrorMessage(undefined);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/billing/economics?period=${monthToPeriod(month)}`,
      );
      if (!res.ok) {
        setErrorMessage(
          res.status === 403
            ? "この画面は super_admin のみが閲覧できます。"
            : undefined,
        );
        setStatus("error");
        return;
      }
      // ★キャストせずランタイム検証する★ 欠けたフィールドを undefined のまま
      // 描画すると本番で画面全体がクラッシュする(flowTransitions の事故と同型)。
      setData(parseMarginSummaryResponse(await res.json()));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [month]);

  useEffect(() => {
    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        navigate("/login", { replace: true });
        return;
      }
      await load();
    })();
  }, [load, navigate]);

  const onSort = (key: string) => {
    if (!SORT_KEYS.includes(key as MarginSortKey)) return;
    const k = key as MarginSortKey;
    if (k === sortBy) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(k);
      setSortOrder("asc");
    }
  };

  const rows = data ? sortMarginRows(data.tenants, sortBy, sortOrder) : [];

  return (
    <div style={{ padding: "24px 20px", maxWidth: 1400, margin: "0 auto" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>テナント別粗利</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>
          売上（推計）から API 原価を引いた採算を、テナント横断で比較します。
        </p>
      </header>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}>
        {/* ★7/30/90日ではなく月セレクタ★ 基本料・込み枠が絡む売上推計は暦月でしか意味を持たない */}
        <label style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
          対象月（JST）
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{
              marginLeft: 8, padding: "8px 10px", minHeight: 40, borderRadius: 8,
              border: "1px solid var(--border)", background: "var(--card)",
              color: "var(--foreground)", fontSize: 14,
            }}
          >
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <button
          style={BTN_LINK}
          disabled={status !== "ready" || rows.length === 0}
          onClick={() => data && exportMarginCsv(rows, month, data.fx.usd_jpy)}
        >
          CSVで書き出す
        </button>
      </div>

      {status === "error" && (
        <LoadErrorBanner message={errorMessage} onRetry={() => void load()} />
      )}

      {status === "loading" && (
        <p style={{ color: "var(--muted-foreground)", fontSize: 14 }}>読み込み中…</p>
      )}

      {/* 提案 → 根拠(表)の順。運営は提案から入る。 */}
      <UpsellProposalsSection />

      {status === "ready" && data && (
        <>
          {data.truncated && (
            // 黙って切らない。上限に当たったことを画面に出す。
            <div
              role="status"
              style={{
                ...CARD, marginBottom: 16, padding: "12px 16px",
                fontSize: 13, color: "var(--muted-foreground)",
              }}
            >
              対象テナントが多いため、一部のみ表示しています（原価の大きい順）。
            </div>
          )}

          <MarginTable
            rows={rows}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={onSort}
            usdJpy={data.fx.usd_jpy}
          />

          <p style={{ marginTop: 12, fontSize: 12, color: "var(--muted-foreground)" }}>
            集計期間: {data.period_from} 〜 {data.period_to}（JST暦月） ／
            原価の逆算に使ったマージン倍率: ×{data.margin_assumed}
          </p>
        </>
      )}
    </div>
  );
}
