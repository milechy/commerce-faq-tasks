// admin-ui/src/pages/admin/billing/TenantUpsellNotice.tsx
//
// /admin/billing の QuotaSection と PlanSection の間に置く、
// テナント向けの「プランのご提案」。★super_admin には出さない★
// (運営は /admin/billing/margin(super_admin専用)で粗利付きの営業提案を見る)。
//
// 根拠(QuotaSection) → 提案(このコンポーネント) → 行動(PlanSection) の順に
// 縦へ並べる。訴求だけ出して行動できない画面にしない。
import { useEffect, useState } from "react";
import { API_BASE, authFetch } from "../../../lib/api";
import { CARD } from "./utils";
import { parseTenantUpsellResponse } from "./upsellSuggestion.schema";

export function TenantUpsellNotice() {
  const [state, setState] = useState<
    { status: "loading" } | { status: "hidden" } | { status: "ready"; headline: string; lines: string[] }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/my-tenant/upsell-suggestion`);
        if (!res.ok) {
          if (!cancelled) setState({ status: "hidden" });
          return;
        }
        // ★ここでもキャストしない★ ホワイトリストパーサを必ず通す。
        const parsed = parseTenantUpsellResponse(await res.json());
        if (cancelled) return;
        if (!parsed.available) {
          setState({ status: "hidden" });
          return;
        }
        setState({ status: "ready", headline: parsed.headline, lines: parsed.lines });
      } catch {
        // 訴求は無くても他の画面機能に影響させない(fail-silent)。
        if (!cancelled) setState({ status: "hidden" });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state.status !== "ready") return null;

  return (
    <section style={{ ...CARD, marginBottom: 24, borderColor: "var(--primary)" }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px" }}>{state.headline}</h2>
      {state.lines.map((line, i) => (
        <p key={i} style={{ margin: i === 0 ? 0 : "6px 0 0", fontSize: 14, color: "var(--foreground)" }}>
          {line}
        </p>
      ))}
    </section>
  );
}
