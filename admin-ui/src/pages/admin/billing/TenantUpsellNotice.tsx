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

interface Suggestion {
  headline: string;
  lines: string[];
}

export function TenantUpsellNotice() {
  // margin/index.tsx・UpsellProposalsSection.tsx と同じ形(status は "loading"|"error"|"ready"
  // の3値、ペイロードは別 state)に揃える。"ready" は「取得に成功した」ことだけを意味し、
  // 提案が無いこと自体はエラーではないので suggestion=null で表す
  // (UpsellProposalsSection が status="ready" のまま proposals.length===0 を
  // 別条件で弾くのと同じ考え方)。
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setStatus("loading");
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/my-tenant/upsell-suggestion`);
        if (!res.ok) {
          if (!cancelled) setStatus("error");
          return;
        }
        // ★ここでもキャストしない★ ホワイトリストパーサを必ず通す。
        const parsed = parseTenantUpsellResponse(await res.json());
        if (cancelled) return;
        if (!parsed.available) {
          setSuggestion(null);
          setStatus("ready");
          return;
        }
        setSuggestion({ headline: parsed.headline, lines: parsed.lines });
        setStatus("ready");
      } catch {
        // 訴求は無くても他の画面機能に影響させない(fail-silent)。
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (status !== "ready" || !suggestion) return null;

  return (
    <section style={{ ...CARD, marginBottom: 24, borderColor: "var(--primary)" }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px" }}>{suggestion.headline}</h2>
      {suggestion.lines.map((line, i) => (
        <p key={i} style={{ margin: i === 0 ? 0 : "6px 0 0", fontSize: 14, color: "var(--foreground)" }}>
          {line}
        </p>
      ))}
    </section>
  );
}
