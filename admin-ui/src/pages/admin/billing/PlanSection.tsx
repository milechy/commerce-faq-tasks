// admin-ui/src/pages/admin/billing/PlanSection.tsx
// テナント自身によるプラン変更。PUT /v1/admin/my-tenant/plan を叩く。
//
// 置き場所が /admin/billing なのは、ここが AdminRoute（テナント管理者も到達可）で
// 支払い設定の導線が既にある唯一の画面だから。super_admin 用のプラン選択は
// /admin/tenants/:id にあるが、そちらは SuperAdminRoute なのでテナントは到達できない。
//
// 表示の原則:
//  - 「即時反映」と書かない。プラン判定キャッシュ(最大60秒・ワーカーごと)と
//    ウィジェット配信の24hキャッシュ(CLAUDE.md 禁止38)があるため嘘になる。
//  - ダウングレードで失う機能を、実行前に必ず名指しで出す。
//  - 金額は倍率で説明する。管理画面の請求額は原価×マージンの表示で、
//    Stripe の実請求(件数×倍率×単価)とは別物のため、円で断定しない。
import { useState } from "react";
import { API_BASE, authFetch } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";
import type { TenantPlan } from "../../../auth/useAuth";
import { GATED_FEATURE_LABELS, planFeatureDelta } from "../../../lib/planFeatures";
import { PLAN_OPTIONS } from "../tenants/types";
import { CARD, BTN_LINK } from "./utils";

/**
 * S5b(PR #918): free_ad への遷移はサーバ側で一時的に 403 ブロック中。
 * free_ad は共有学習プールへの参加が強制ONで、消費者向け同意バナーの
 * 開示基盤が整うまで free_ad テナントを増やさない方針のため。
 *
 * 強制はあくまでサーバ側(blockFreeAdTransition)で行う。ここは
 * 「押せるのに403になるボタン」を出さないための表示上の配慮にすぎない
 * (CLAUDE.md 禁止14: 機能ゲートをUI側だけに置かない)。
 * サーバのブロックを外すときは、この定数も false にすること。
 */
const FREE_AD_BLOCKED = true;
const FREE_AD_BLOCKED_NOTE = "無料プランへの変更は現在受け付けていません（データ共有の同意表示を準備中のため）。";

/** free_ad は「原価をR2Cが負担する」枠なので、選ぶ前に制約を明示する。 */
const FREE_AD_NOTES = [
  "月200リクエストまで（超過すると新しい会話が止まります）",
  "ウィジェットに「Powered by R2C」バッジが表示されます",
  "会話データの共有学習プールへの提供が必須になります",
];

export function PlanSection({
  currentPlan,
  planStatus = "ready",
  onChanged,
  showToast,
}: {
  currentPlan: TenantPlan | null;
  /**
   * currentPlan が null の理由を明示するための状態。
   * GID 1217808323616744(P1-7): super_admin で常に「確認中」に固まっていたバグの原因は
   * 未取得(loading)・失敗(error)・単に値が無い の3つを区別していなかったこと。
   * 呼び出し元が取得中/失敗を把握していない場合は既定の "ready" のままでよい
   * (currentPlan が null なら従来どおり不明表示になる)。
   */
  planStatus?: "loading" | "error" | "ready";
  onChanged: (plan: TenantPlan) => void;
  showToast: (msg: string) => void;
}) {
  const { user } = useAuth();
  const [pending, setPending] = useState<TenantPlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CLAUDE.md 禁止13: isSuperAdmin で出し分けない（previewMode 中に false へ落ちる）。
  // ここは生の role で判定する。super_admin のJWTには tenant_id が無く、
  // API 側が 403 を返すため、押せるボタンとして出してはいけない。
  const canChangePlan = user?.role === "client_admin";

  const target = pending;
  const delta = target ? planFeatureDelta(currentPlan, target) : null;
  const currentOption = PLAN_OPTIONS.find((o) => o.value === currentPlan);
  const targetOption = target ? PLAN_OPTIONS.find((o) => o.value === target) : null;

  const handleConfirm = async () => {
    if (!target) return;
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/my-tenant/plan`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: target }),
      });
      if (res.ok) {
        // 成功応答でも本文がJSONとは限らない(204・空ボディ・プロキシの割り込み)。
        // ここで throw させると「サーバは変更済みなのに失敗表示」になり、
        // ユーザーが再送する(2回目はサーバ側 no-op)。本文が読めなくても成功は成功として扱う。
        const data = (await res.json().catch(() => ({}))) as { plan?: TenantPlan };
        onChanged(data.plan ?? target);
        setPending(null);
        showToast("✅ プランを変更しました");
      } else {
        const d = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(d.message ?? d.error ?? "プランの変更に失敗しました");
      }
    } catch {
      setError("プランの変更に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={{ ...CARD, marginBottom: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--muted-foreground)", margin: "0 0 4px" }}>
        プラン
      </h2>
      <p style={{ margin: planStatus === "error" ? "0 0 4px" : "0 0 16px", fontSize: 14, color: "var(--foreground)" }}>
        現在のプラン:{" "}
        {planStatus === "loading" ? (
          <strong style={{ fontSize: 16, color: "var(--muted-foreground)", fontWeight: 600 }}>
            読み込み中…
          </strong>
        ) : planStatus === "error" ? (
          <strong style={{ fontSize: 16, color: "#fbbf24" }}>取得できませんでした</strong>
        ) : (
          <strong style={{ fontSize: 16 }}>{currentOption?.label ?? "不明"}</strong>
        )}
        {planStatus === "ready" && currentOption && (
          <span style={{ color: "#a78bfa", marginLeft: 8 }}>
            対話単価 ×{currentOption.multiplier.toFixed(1)}
          </span>
        )}
      </p>

      {planStatus === "error" && (
        <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted-foreground)" }}>
          通信状況をご確認のうえ、ページを再読み込みしてください。
        </p>
      )}

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {PLAN_OPTIONS.map((opt) => {
          const isCurrent = opt.value === currentPlan;
          const isBlocked = FREE_AD_BLOCKED && opt.value === "free_ad" && !isCurrent;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={!canChangePlan || isCurrent || isBlocked}
              onClick={() => { setError(null); setPending(opt.value); }}
              style={{
                flex: "1 1 200px",
                textAlign: "left",
                padding: "12px 14px",
                minHeight: 44,
                borderRadius: 10,
                border: `1px solid ${isCurrent ? "rgba(124,58,237,0.6)" : "var(--border)"}`,
                background: isCurrent ? "rgba(124,58,237,0.15)" : "rgba(255,255,255,0.02)",
                color: "var(--foreground)",
                cursor: !canChangePlan || isCurrent || isBlocked ? "default" : "pointer",
                opacity: isBlocked || (!canChangePlan && !isCurrent) ? 0.6 : 1,
              }}
            >
              <span style={{ display: "block", fontWeight: 700, fontSize: 14 }}>
                {opt.label}{" "}
                <span style={{ color: "#a78bfa" }}>×{opt.multiplier.toFixed(1)}</span>
                {isCurrent && (
                  <span style={{ marginLeft: 6, fontSize: 11, color: "var(--muted-foreground)" }}>
                    （利用中）
                  </span>
                )}
              </span>
              <span style={{ display: "block", fontSize: 12, color: "var(--muted-foreground)", marginTop: 2 }}>
                {isBlocked ? FREE_AD_BLOCKED_NOTE : opt.desc}
              </span>
            </button>
          );
        })}
      </div>

      {!canChangePlan && (
        <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--muted-foreground)" }}>
          プランの変更はテナント管理者アカウントから行えます。
        </p>
      )}

      {target && targetOption && (
        <div
          style={{
            marginTop: 16,
            padding: "16px 18px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "rgba(0,0,0,0.25)",
          }}
        >
          <p style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "var(--foreground)" }}>
            {currentOption?.label ?? "現在のプラン"} → {targetOption.label} に変更しますか？
          </p>

          {/* 費用。円で断定せず、倍率と「遡らない」ことを伝える。 */}
          <div style={{ marginBottom: 12 }}>
            <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>
              料金の変わり方
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
              <li>
                対話単価が ×{currentOption?.multiplier.toFixed(1) ?? "—"} から{" "}
                ×{targetOption.multiplier.toFixed(1)} になります。
              </li>
              <li>変更前にご利用いただいた分は、変更前の単価のまま請求されます（遡って変わりません）。</li>
              {targetOption.value === "free_ad" && (
                <li>従量課金は発生しません（原価は当社が負担します）。</li>
              )}
            </ul>
          </div>

          {delta && delta.gained.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 600, color: "#4ade80" }}>
                使えるようになる機能
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
                {delta.gained.map((f) => <li key={f}>{GATED_FEATURE_LABELS[f]}</li>)}
              </ul>
            </div>
          )}

          {delta && delta.lost.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 600, color: "#fbbf24" }}>
                使えなくなる機能
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
                {delta.lost.map((f) => <li key={f}>{GATED_FEATURE_LABELS[f]}</li>)}
              </ul>
            </div>
          )}

          {targetOption.value === "free_ad" && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 600, color: "#fbbf24" }}>
                無料プランの条件
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
                {FREE_AD_NOTES.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </div>
          )}

          {/* 反映タイミング。「即時」と書かないこと（キャッシュ2段）。 */}
          <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
            管理画面への反映には最大1分ほどかかります。サイトに設置したウィジェットの表示
            （バッジなど）は、配信キャッシュの都合で反映まで最大24時間かかることがあります。
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleConfirm()}
              style={{
                padding: "12px 20px",
                minHeight: 44,
                borderRadius: 10,
                border: "none",
                background: saving
                  ? "rgba(34,197,94,0.3)"
                  : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
                color: "#022c22",
                fontSize: 15,
                fontWeight: 700,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "変更中..." : `${targetOption.label} に変更する`}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => { setPending(null); setError(null); }}
              style={{ ...BTN_LINK, fontSize: 14 }}
            >
              やめる
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
