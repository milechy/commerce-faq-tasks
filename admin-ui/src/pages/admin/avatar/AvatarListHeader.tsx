// admin-ui/src/pages/admin/avatar/AvatarListHeader.tsx
// index.tsx から抽出 — ページヘッダー（タイトル / 件数 / 新規作成ボタン）（機能変更なし）

import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import type { AvatarConfig } from "./types";
import type { TenantPlan } from "../../../auth/useAuth";
import { planHasFeature } from "../../../lib/planFeatures";
import { PLAN_OPTIONS } from "../tenants/types";

export function AvatarListHeader({
  loading,
  isSuperAdmin,
  displayedConfigs,
  total,
  tenantPlan,
}: {
  loading: boolean;
  isSuperAdmin: boolean;
  displayedConfigs: AvatarConfig[];
  total: number;
  // [AV-3] 作成ボタンのプランゲート判定に使う。未取得(null)の間は
  // planHasFeature が false を返す(fail-safe = 制限側)ので誤って活性化しない。
  tenantPlan: TenantPlan | null;
}) {
  const navigate = useNavigate();
  const { lang } = useLang();
  const canCreate = planHasFeature(tenantPlan, "avatar_customize");
  const requiredPlanLabel = PLAN_OPTIONS.find((p) => p.value === "growth")?.label ?? "Growth";
  const currentPlanLabel = tenantPlan
    ? (PLAN_OPTIONS.find((p) => p.value === tenantPlan)?.label ?? tenantPlan)
    : (lang === "ja" ? "確認中" : "checking");
  const gateMessage = lang === "ja"
    ? `アバターの作成・カスタマイズは${requiredPlanLabel}プラン以上でご利用いただけます（現在のプラン: ${currentPlanLabel}）`
    : `Avatar creation/customization requires the ${requiredPlanLabel} plan or above (current plan: ${currentPlanLabel})`;

  return (
    <header style={{ marginBottom: 28 }}>
      <button
        onClick={() => navigate("/admin")}
        style={{ background: "none", border: "none", color: "var(--muted-foreground)", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 10, display: "block" }}
      >
        {lang === "ja" ? "← 管理画面に戻る" : "← Back to Admin"}
      </button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "var(--foreground)", display: "flex", alignItems: "center", gap: 8 }}>
            🎭 {lang === "ja" ? "アバター設定" : "Avatar Configs"}
          </h1>
          <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: "4px 0 0" }}>
            {lang === "ja"
              ? "接客アバターの見た目・声・性格を作成・管理できます"
              : "Create and manage your chat avatar's appearance, voice, and personality"}
          </p>
          {!loading && (
            <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: "4px 0 0" }}>
              {isSuperAdmin
                ? (lang === "ja" ? `全テナント: ${displayedConfigs.length}/${total}件` : `All tenants: ${displayedConfigs.length}/${total}`)
                : (lang === "ja" ? `${total}件の設定` : `${total} config${total !== 1 ? "s" : ""}`)
              }
            </p>
          )}
        </div>
        {!isSuperAdmin && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => navigate("/admin/avatar/wizard")}
                disabled={!canCreate}
                title={canCreate ? undefined : gateMessage}
                style={{
                  padding: "10px 20px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "1px solid rgba(245,158,11,0.4)",
                  background: "rgba(245,158,11,0.12)",
                  color: "#fcd34d",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: canCreate ? "pointer" : "not-allowed",
                  opacity: canCreate ? 1 : 0.5,
                }}
              >
                ✨ {lang === "ja" ? "AI生成" : "AI Generate"}
              </button>
              <button
                onClick={() => navigate("/admin/avatar/studio")}
                disabled={!canCreate}
                title={canCreate ? undefined : gateMessage}
                style={{
                  padding: "10px 20px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg, #3b82f6, #6366f1)",
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: canCreate ? "pointer" : "not-allowed",
                  opacity: canCreate ? 1 : 0.5,
                }}
              >
                {lang === "ja" ? "+ 新規作成" : "+ New Config"}
              </button>
            </div>
            {/* [AV-3] avatar_customize(Growth〜)未達: ボタンは隠さず非活性+理由表示でアップセルにする */}
            {!canCreate && (
              <div style={{
                padding: "8px 12px",
                borderRadius: 8,
                background: "rgba(234,179,8,0.08)",
                border: "1px solid rgba(234,179,8,0.3)",
                fontSize: 12,
                color: "#fbbf24",
                lineHeight: 1.6,
                maxWidth: 320,
                textAlign: "right",
              }}>
                🔒 {gateMessage}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
