// admin-ui/src/components/PreviewModeBanner.tsx
// super_adminの「クライアントビューで見る」プレビュー中に全ページ共通で表示する終了バナー。
// 旧実装はadmin/index.tsx(ダッシュボード)にのみ存在し、他ページへ遷移すると
// バナーごと「元に戻す」導線が消えていた(GID 1216274382443624)。App.tsxのAppInnerで
// 一度だけレンダリングすることで、どのページからでもプレビューを終了できるようにする。

import { useAuth } from "../auth/useAuth";
import { useLang } from "../i18n/LangContext";

export const PREVIEW_MODE_BANNER_HEIGHT = 44;

export function PreviewModeBanner() {
  const { previewMode, previewTenantName, exitPreview } = useAuth();
  const { t } = useLang();

  if (!previewMode) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: "rgba(234,179,8,0.95)",
        padding: "10px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        fontSize: 14,
        fontWeight: 600,
        color: "#1c1917",
        boxShadow: "0 2px 12px rgba(0,0,0,0.2)",
      }}
    >
      <span>👁 {t("preview.mode_label")}</span>
      <span style={{ color: "#78350f" }}>
        {t("preview.viewing_as", { tenant: previewTenantName ?? "" })}
      </span>
      <button
        onClick={exitPreview}
        style={{
          padding: "6px 14px",
          borderRadius: 999,
          border: "1px solid #78350f",
          background: "rgba(0,0,0,0.15)",
          color: "#1c1917",
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {t("preview.exit")}
      </button>
    </div>
  );
}
