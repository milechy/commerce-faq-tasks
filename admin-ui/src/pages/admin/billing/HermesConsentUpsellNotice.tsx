// admin-ui/src/pages/admin/billing/HermesConsentUpsellNotice.tsx
//
// /admin/billing の TenantUpsellNotice(プランのご提案)の直下に置く、
// 共有学習プール(Hermes/A2A)への参加をポジティブに勧める訴求カード。
// ★super_admin には出さない★(運営はここでは扱わない)。
//
// 経緯: 同意トグル自体は /admin/tuning に既にあるが、そこは受動的な設置場所に
// すぎず能動的な勧誘導線が無かったため、本番同意率が低いまま(2026-09-05実測:
// 4テナント中2社のみ)だった。プランアップセルと同じ「導線」の位置づけで
// A2A/Hermesの魅力(give-to-get)を伝える。
//
// ★原価・粗利は一切出さない★(TenantUpsellNotice と同じ方針。この画面は
// client_admin が見るため、金額は基本料と込み枠だけに留める既存ルールを踏襲し、
// ここでは金額そのものを一切扱わない — 同意にコストは発生しないため)。
//
// 表示条件は「share=false の間は常に表示」(閉じても二度と出さない、という
// 抑制フラグは持たない)。同意済みになった瞬間に自然に消える。
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, authFetch } from "../../../lib/api";
import { CARD } from "./utils";
import { resolveShare, type TenantFeaturesLike } from "../../../lib/hermesShare";

type State =
  | { status: "loading" }
  | { status: "hidden" }
  | { status: "ready" }
  | { status: "saving" }
  | { status: "done" };

export function HermesConsentUpsellNotice() {
  const navigate = useNavigate();
  const [features, setFeatures] = useState<TenantFeaturesLike | null>(null);
  const [state, setState] = useState<State>({ status: "loading" });
  const [errorToast, setErrorToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/my-tenant`);
        if (!res.ok) {
          if (!cancelled) setState({ status: "hidden" });
          return;
        }
        const data = (await res.json()) as { features?: TenantFeaturesLike };
        if (cancelled) return;
        const f = data.features ?? null;
        if (resolveShare(f)) {
          // 既に同意済み(free_adの強制ONを含む) — 訴求の必要が無い。
          setState({ status: "hidden" });
          return;
        }
        setFeatures(f);
        setState({ status: "ready" });
      } catch {
        // 訴求は無くても他の画面機能に影響させない(fail-silent。TenantUpsellNoticeと同じ方針)。
        if (!cancelled) setState({ status: "hidden" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleJoin = async () => {
    if (state.status !== "ready") return;
    setState({ status: "saving" });
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/my-tenant`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: {
            ...features,
            learning: { learn: features?.learning?.learn ?? true, share: true },
          },
        }),
      });
      if (!res.ok) {
        setState({ status: "ready" });
        setErrorToast("設定の更新に失敗しました。時間をおいて再度お試しください。");
        setTimeout(() => setErrorToast(null), 4000);
        return;
      }
      setState({ status: "done" });
    } catch {
      setState({ status: "ready" });
      setErrorToast("設定の更新に失敗しました。時間をおいて再度お試しください。");
      setTimeout(() => setErrorToast(null), 4000);
    }
  };

  if (state.status === "loading" || state.status === "hidden") return null;

  if (state.status === "done") {
    return (
      <section style={{ ...CARD, marginBottom: 24, borderColor: "rgba(74,222,128,0.4)" }}>
        <p style={{ margin: 0, fontSize: 14, color: "var(--foreground)" }}>
          🌐 ご参加ありがとうございます。他社の会話から学んだ改善が、順次貴社のAIにも反映されます。
        </p>
      </section>
    );
  }

  const saving = state.status === "saving";

  return (
    <section style={{ ...CARD, marginBottom: 24, borderColor: "rgba(59,130,246,0.4)" }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px", color: "var(--foreground)" }}>
        🌐 他社が磨いたAIの接客力を、そのまま貴社にも
      </h2>
      <p style={{ margin: 0, fontSize: 14, color: "var(--foreground)" }}>
        全国の参加テナントの会話から見つかった「効果的な言い回し」が「グローバルルール」として、貴社が何もしなくても自動でAIの応答に反映されます。自社の会話データだけでAIを育てるより、はるかに早く賢くなります。
      </p>
      <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 14, color: "var(--foreground)" }}>
        <li>参加は無料。追加費用は一切かかりません</li>
        <li>共有されるのは匿名化された会話ログ・行動データのみで、金額情報は含まれません</li>
        <li>いつでもOFFに戻せます</li>
      </ul>
      <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void handleJoin()}
          disabled={saving}
          style={{
            padding: "10px 20px",
            minHeight: 44,
            borderRadius: 8,
            border: "1px solid rgba(59,130,246,0.5)",
            background: "rgba(59,130,246,0.18)",
            color: "#93c5fd",
            fontSize: 14,
            fontWeight: 700,
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "処理中…" : "🌐 今すぐ参加する"}
        </button>
        <button
          type="button"
          onClick={() => navigate("/admin/tuning")}
          style={{
            padding: "10px 4px",
            border: "none",
            background: "transparent",
            color: "var(--muted-foreground)",
            fontSize: 13,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          詳しい設定はこちら
        </button>
      </div>
      {errorToast && (
        <p style={{ marginTop: 10, fontSize: 13, color: "#fca5a5" }}>{errorToast}</p>
      )}
    </section>
  );
}
