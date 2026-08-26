// admin-ui/src/pages/admin/billing/QuotaSection.tsx
// UX-C(2026-08-26): 込み枠・無料枠の当月消費を可視化する。
//
// #1015でStandard/Growthに込み枠(基本料に含まれる利用量)を導入したが、消費量・
// 残量を出す画面が無かった(admin-ui横断grepでゼロ件)。上限を設けない従量課金方針
// ([[project_usage_based_billing_no_caps]])のもとでは、「気づいたら大幅超過」を
// 防ぐ唯一の手段がこの表示。データはGET /v1/admin/billing/quotaから受け取るだけの
// 純粋な表示コンポーネント(fetchは呼び出し元のindex.tsxが担う。他のSection群と同じ作法)。
import type { BillingQuota } from "./types";
import { CARD } from "./utils";

function pct(used: number, included: number): number {
  if (included <= 0) return 0;
  return Math.min(100, Math.round((used / included) * 100));
}

/** 消費率に応じて色を変える。80%未満=緑、80〜99%=黄、100%以上=赤。 */
function barColor(percentage: number): string {
  if (percentage >= 100) return "#f87171";
  if (percentage >= 80) return "#fbbf24";
  return "#4ade80";
}

function QuotaBar({
  label, used, included, unit, overage, overageUnit,
}: {
  label: string;
  used: number;
  included: number;
  unit: string;
  overage: number;
  overageUnit: string;
}) {
  const percentage = pct(used, included);
  const color = barColor(percentage);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{label}</span>
        <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
          {used.toLocaleString("ja-JP")} / {included.toLocaleString("ja-JP")} {unit}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "rgba(120,120,140,0.15)", overflow: "hidden" }}>
        <div style={{ width: `${percentage}%`, height: "100%", background: color, transition: "width 0.3s" }} />
      </div>
      {overage > 0 && (
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "#fbbf24" }}>
          込み枠を {overage.toLocaleString("ja-JP")}{overageUnit} 超過しています(超過分は従量で加算されます)
        </p>
      )}
    </div>
  );
}

export function QuotaSection({
  quota,
  status,
}: {
  quota: BillingQuota | null;
  status: "loading" | "error" | "ready";
}) {
  if (status === "loading") {
    return (
      <section style={{ ...CARD, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 4px" }}>
          今月の利用枠
        </h2>
        {/* ★PlanSectionの汎用的な「読み込み中」「取得できませんでした」と部分文字列
            レベルでも衝突させない★ getByText は部分一致なので、接頭辞を足すだけでは
            互いの正規表現がもう一方にもマッチしてしまう。語彙そのものを変える。 */}
        <p style={{ margin: 0, fontSize: 14, color: "var(--muted-foreground)" }}>集計しています…</p>
      </section>
    );
  }

  if (status === "error" || !quota) {
    return (
      <section style={{ ...CARD, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 4px" }}>
          今月の利用枠
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>
          通信状況により表示できません。ページを再読み込みしてください。
        </p>
      </section>
    );
  }

  const { plan, text, avatar, freeAd } = quota;

  return (
    <section style={{ ...CARD, marginBottom: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 4px" }}>
        今月の利用枠
      </h2>

      {freeAd && (
        <>
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted-foreground)" }}>
            月{freeAd.limit.toLocaleString("ja-JP")}会話まで無料でご利用いただけます。到達すると新しい会話は一時停止します。
          </p>
          <QuotaBar
            label="会話数"
            used={freeAd.used}
            included={freeAd.limit}
            unit="会話"
            overage={0}
            overageUnit="会話"
          />
          {freeAd.remaining === 0 ? (
            <p style={{ margin: "0", fontSize: 13, color: "#f87171", fontWeight: 600 }}>
              今月の上限に到達しています。新しい会話は翌月まで開始できません。
            </p>
          ) : freeAd.remaining <= freeAd.limit * 0.2 ? (
            <p style={{ margin: "0", fontSize: 13, color: "#fbbf24" }}>
              残り{freeAd.remaining.toLocaleString("ja-JP")}会話です。上限に近づいています。
            </p>
          ) : null}
        </>
      )}

      {plan === "enterprise" && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>
          Enterpriseプランは利用量に上限がありません(当月{text.used.toLocaleString("ja-JP")}会話・{avatar.usedMinutes.toLocaleString("ja-JP")}分のアバター利用)。
        </p>
      )}

      {plan === "starter" && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>
          Starterは込み枠の無い純従量プランです(当月{text.used.toLocaleString("ja-JP")}会話をご利用中)。
        </p>
      )}

      {(plan === "standard" || plan === "growth") && text.included !== null && avatar.includedMinutes !== null && (
        <>
          <QuotaBar
            label="テキスト会話"
            used={text.used}
            included={text.included}
            unit="会話"
            overage={text.overage}
            overageUnit="会話"
          />
          <QuotaBar
            label="アバター利用"
            used={avatar.usedMinutes}
            included={avatar.includedMinutes}
            unit="分"
            overage={avatar.overageMinutes}
            overageUnit="分"
          />
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--muted-foreground)" }}>
            テキストとアバターは別枠です。月の途中でプランを変更した場合、その月の込み枠は変更後のプランの枠が月全体に適用されます(日割りしません)。
          </p>
        </>
      )}
    </section>
  );
}
