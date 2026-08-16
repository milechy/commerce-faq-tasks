// admin-ui/src/components/common/LoadErrorBanner.tsx
// 読み込み失敗(5xx・ネットワーク断など)の共通バナー。再試行導線を必ず伴う。
//
// 「エラー文言に次の行動を書く / 再試行を促すなら再試行ボタンを同時に置く」
// (CLAUDE.md 命名・エラーハンドリング)を1箇所で満たすための部品。
// 配色は --destructive 系トークンを使う。ダーク前提のハードコード色
// (rgba(127,29,29,*) + #fca5a5)はライトテーマで判読不能になる。
import { useLang } from "../../i18n/LangContext";

export function LoadErrorBanner({
  message,
  onRetry,
}: {
  /** 省略時は共通文言 common.load_failed。画面固有の説明が要る場合のみ渡す */
  message?: string;
  onRetry: () => void;
}) {
  const { t } = useLang();

  return (
    <div
      role="alert"
      style={{
        marginBottom: 20,
        padding: "14px 18px",
        borderRadius: 12,
        background: "var(--destructive-surface)",
        border: "1px solid var(--destructive-border)",
        color: "var(--destructive)",
        fontSize: 15,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span>{message ?? t("common.load_failed")}</span>
      <button
        onClick={onRetry}
        style={{
          padding: "10px 20px",
          // Mobile First: タップ領域は44px以上(Core Principles)
          minHeight: 44,
          borderRadius: 10,
          border: "1px solid var(--destructive-border)",
          background: "transparent",
          color: "var(--destructive)",
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {t("common.retry")}
      </button>
    </div>
  );
}
