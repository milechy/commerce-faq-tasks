// admin-ui/src/components/common/PlanLimitNotice.tsx
// プラン制限(403 plan_upgrade_required)の案内。
//
// これは「エラー」ではなく正常系の分岐なので、赤帯・❌・「失敗」の語彙を使わない
// (CLAUDE.md 絶対にやってはいけないこと 21)。サーバが返した message を
// そのまま見せ、無い場合だけ共通のフォールバック文言に落とす。
import { useLang } from "../../i18n/LangContext";

export function PlanLimitNotice({ message }: { message: string | null }) {
  const { t } = useLang();

  return (
    <div
      style={{
        marginBottom: 20,
        padding: "14px 18px",
        borderRadius: 12,
        background: "var(--card)",
        border: "1px solid var(--border)",
        color: "var(--foreground)",
        fontSize: 15,
      }}
    >
      ✨ {message ?? t("common.plan_limit_generic")}
    </div>
  );
}
