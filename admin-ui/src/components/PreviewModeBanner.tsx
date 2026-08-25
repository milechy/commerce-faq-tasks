// admin-ui/src/components/PreviewModeBanner.tsx
// super_adminの「クライアントビューで見る」プレビュー中に全ページ共通で表示する終了バナー。
// 旧実装はadmin/index.tsx(ダッシュボード)にのみ存在し、他ページへ遷移すると
// バナーごと「元に戻す」導線が消えていた(GID 1216274382443624)。App.tsxのAppInnerで
// 一度だけレンダリングすることで、どのページからでもプレビューを終了できるようにする。

import { useLayoutEffect, useRef } from "react";
import { useAuth } from "../auth/useAuth";
import { useLang } from "../i18n/LangContext";

// position: fixedなこのバナー分の高さを、他ページ側(App.tsxのスペーサー・
// /copilot-previewのcp-shell)が確保するための目安値。実際の描画高さはテナント名の
// 長さ・折り返し・フォントレンダリングで変わりうるため、この定数はJS計測前の
// フォールバックとしてのみ使う。実測値は下のResizeObserverでCSS変数
// (--preview-banner-height, documentElementに書き込む)へ反映し、以降はそちらを
// 正とする(GID 1217808308055510: 固定値だけを信じるとズレて後続のヘッダーに重なる)。
export const PREVIEW_MODE_BANNER_HEIGHT = 44;
export const PREVIEW_BANNER_HEIGHT_CSS_VAR = "--preview-banner-height";

export function PreviewModeBanner() {
  const { previewMode, previewTenantName, exitPreview } = useAuth();
  const { t } = useLang();
  const ref = useRef<HTMLDivElement>(null);

  // マウント中は実測した高さをdocumentRootのCSS変数に反映し続け、アンマウント時は
  // 0pxに戻す。ResizeObserver未実装の環境(古いブラウザ・一部のテスト環境)では
  // 初回計測だけ行い、固定値フォールバックに委ねる。
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!previewMode) {
      root.style.setProperty(PREVIEW_BANNER_HEIGHT_CSS_VAR, "0px");
      return;
    }
    const el = ref.current;
    if (!el) return;
    const applyHeight = () => {
      root.style.setProperty(PREVIEW_BANNER_HEIGHT_CSS_VAR, `${el.offsetHeight}px`);
    };
    applyHeight();
    if (typeof ResizeObserver === "undefined") {
      return () => root.style.setProperty(PREVIEW_BANNER_HEIGHT_CSS_VAR, "0px");
    }
    const observer = new ResizeObserver(applyHeight);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.setProperty(PREVIEW_BANNER_HEIGHT_CSS_VAR, "0px");
    };
  }, [previewMode, previewTenantName]);

  if (!previewMode) return null;

  return (
    <div
      ref={ref}
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
