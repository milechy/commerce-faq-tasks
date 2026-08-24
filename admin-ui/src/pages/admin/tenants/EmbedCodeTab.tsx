import { useState } from "react";
import { useLang } from "../../../i18n/LangContext";
import ApiKeyCreateModal from "../../../components/ApiKeyCreateModal";
import type { TenantDetail, ApiKey } from "./types";
import { CARD_STYLE } from "./types";

/** 既定値と同じ設定・不正値は出力しない（コピペ用スニペットを短く保ち、壊れた属性を出さない） */
function buildPlacementLines(theme: TenantDetail["widget_theme"]): string {
  if (!theme) return "";
  const lines: string[] = [];

  if (theme.position === "bottom-left") {
    lines.push(`data-position="bottom-left"`);
  }
  const offsets: Array<["offsetX" | "offsetY", string]> = [
    ["offsetX", "data-offset-x"],
    ["offsetY", "data-offset-y"],
  ];
  for (const [key, attr] of offsets) {
    const raw = theme[key];
    const n = typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw.trim()))
      ? Number(raw)
      : NaN;
    if (Number.isInteger(n) && n >= 0 && n <= 320 && n !== 24) {
      lines.push(`${attr}="${n}"`);
    }
  }

  return lines.map((l) => `\n  ${l}`).join("");
}

/**
 * 埋め込みスニペットを組み立てる（純関数）。
 * widget.js が実際に読む属性のみ出力する。data-title / data-color は
 * widget.js 側に対応する読み取りが存在せず(タイトルは固定文言、色は
 * data-accent-color)、tenant.widgetTitle / widgetColor もバックエンドから
 * 一度も返されたことがないため、常に "undefined" 文字列がテナントの
 * コピペ用スニペットに混入していた。
 *
 * apiKey は必ず平文の実キーを渡すこと（マスク済み値は絶対に渡さない。
 * 貼っても認証を通らないコードをテナントに配らせないため）。
 */
export function buildEmbedCode(tenant: TenantDetail, apiKey: string): string {
  // ブランドカラーは set_widget_theme(チャットツール)が widget_theme.primaryColor に
  // 保存する。書き込み時に #RRGGBB 形式を検証済みだが、直接DBを触られた場合の
  // 防御として出力直前にも再検証する。
  const primaryColor = tenant.widget_theme?.primaryColor;
  const accentColorLine = typeof primaryColor === "string" && /^#[0-9a-fA-F]{6}$/.test(primaryColor)
    ? `\n  data-accent-color="${primaryColor}"`
    : "";
  // 設置位置。FAB は z-index に int 最大値を使うため、サイト側の「トップへ戻る」ボタン等が
  // 右下にあると相手がクリック不能になる。その逃げ道として position / offsetX / offsetY を出力する。
  // ⚠️ 同じ判定が src/api/admin/agent/widgetPlacement.ts にもある(別ビルドで import 共有不可)。
  // 片方だけ直さない。丸め範囲は public/widget.js の parseOffset() と一致させること。
  const placementLines = buildPlacementLines(tenant.widget_theme);
  // data-tenant は tenant.id を使う（widget.js/routes.ts のコメントで「slug = tenant ID」と
  // 明記されている。tenants テーブルに slug 列自体が存在しないため、別の slug フィールドは無い）。
  //
  // src は動的ルート GET /widget/:tenantSlug.js（src/api/widget/routes.ts）を指す。
  // 静的な /widget.js を直接返すだけの旧URLは、プラン別バッジ制御(showBrandingBadge)を
  // 一切経由できず、free_ad等のバッジ配布経路が事実上存在しなかった(GID 1217762331236037)。
  // 動的ルートのレスポンスは public/widget.js の全文にテナント設定ブロックを前置したものであり、
  // data-api-key/data-tenant/data-accent-color/placement系の各属性は静的経路と全く同じ
  // currentScript.getAttribute(...) の仕組みで読まれるため、ここでの変更は不要。
  // 既に静的URLで埋め込み済みの稼働中テナントはこの変更の影響を受けない(後方互換)。
  // 次回このタブでコードをコピーした時点から新URLになる。
  return `<script src="https://api.r2c.biz/widget/${tenant.id}.js"
  data-api-key="${apiKey}"
  data-tenant="${tenant.id}"${accentColorLine}${placementLines}>
</script>`;
}

export default function EmbedCodeTab({ tenant, apiKeys }: { tenant: TenantDetail; apiKeys: ApiKey[] }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const [copiedPurchase, setCopiedPurchase] = useState(false);
  const [copiedInquiry, setCopiedInquiry] = useState(false);
  // 発行直後の平文キー。POST /keys のレスポンスでのみ得られ、DBにはハッシュしか無いため
  // 二度と取得できない。ページを離れる/リロードすると消えるのは意図的な設計。
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [showIssueModal, setShowIssueModal] = useState(false);

  const activeKey = apiKeys.find((k) => k.status === "active");

  const handleIssueClick = () => {
    // 既に有効なキーがある状態での発行は、そのキーを即座に無効化する
    // （tenant-context.ts の registerTenant がテナントあたり1キーを上書きするため）。
    // 稼働中のウィジェットが止まることを誤操作前に明示する。
    if (activeKey && !window.confirm(t("tenant_detail.embed_reissue_confirm"))) {
      return;
    }
    setShowIssueModal(true);
  };

  const embedCode = issuedKey ? buildEmbedCode(tenant, issuedKey) : null;

  const purchaseTag = `<script>\n  window.r2c && r2c.trackConversion('purchase', /* 購入金額(円) */ 0);\n</script>`;
  const inquiryTag = `<script>\n  window.r2c && r2c.trackConversion('inquiry');\n</script>`;

  const handleCopy = async () => {
    if (!embedCode) return;
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API not available
    }
  };

  const handleCopyPurchase = async () => {
    try {
      await navigator.clipboard.writeText(purchaseTag);
      setCopiedPurchase(true);
      setTimeout(() => setCopiedPurchase(false), 2000);
    } catch {
      // clipboard API not available
    }
  };

  const handleCopyInquiry = async () => {
    try {
      await navigator.clipboard.writeText(inquiryTag);
      setCopiedInquiry(true);
      setTimeout(() => setCopiedInquiry(false), 2000);
    } catch {
      // clipboard API not available
    }
  };

  const CODE_STYLE: React.CSSProperties = {
    fontFamily: "monospace",
    background: "rgba(0,0,0,0.5)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "16px",
    fontSize: 13,
    color: "#86efac",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    marginBottom: 10,
  };

  const COPY_BTN_STYLE = (active: boolean): React.CSSProperties => ({
    padding: "10px 20px",
    minHeight: 44,
    borderRadius: 10,
    border: "none",
    background: active
      ? "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)"
      : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
    color: "#022c22",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    width: "100%",
  });

  return (
    <div>
      {(!tenant.allowed_origins || tenant.allowed_origins.length === 0) && (
        <div
          style={{
            marginBottom: 16,
            padding: "14px 16px",
            borderRadius: 12,
            background: "rgba(120,53,15,0.4)",
            border: "1px solid rgba(251,191,36,0.3)",
            color: "#fbbf24",
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          {t("tenant_detail.embed_no_origins_warning")}
        </div>
      )}
      <div style={CARD_STYLE}>
        <p style={{ fontSize: 14, color: "var(--muted-foreground)", marginBottom: 16, lineHeight: 1.6 }}>
          {t("tenant_detail.embed_desc")}
        </p>

        {embedCode ? (
          <>
            <div
              style={{
                marginBottom: 16,
                padding: "12px 16px",
                borderRadius: 10,
                background: "rgba(120,53,15,0.4)",
                border: "1px solid rgba(251,191,36,0.3)",
                color: "#fbbf24",
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.5,
              }}
            >
              {t("tenant_detail.embed_issued_warning")}
            </div>
            <pre
              style={{
                fontFamily: "monospace",
                background: "rgba(0,0,0,0.5)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "16px",
                fontSize: 13,
                color: "#86efac",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                marginBottom: 16,
              }}
            >
              {embedCode}
            </pre>
            <button
              onClick={handleCopy}
              style={{
                padding: "14px 24px",
                minHeight: 50,
                borderRadius: 12,
                border: "none",
                background: copied
                  ? "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)"
                  : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
                color: "#022c22",
                fontSize: 16,
                fontWeight: 700,
                cursor: "pointer",
                width: "100%",
              }}
            >
              {copied ? t("tenant_detail.copied") : t("tenant_detail.copy")}
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 14, color: "var(--muted-foreground)", marginBottom: 16, lineHeight: 1.6 }}>
              {t("tenant_detail.embed_key_unavailable")}
            </p>
            <button
              onClick={handleIssueClick}
              style={{
                padding: "14px 24px",
                minHeight: 50,
                borderRadius: 12,
                border: "none",
                background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
                color: "#022c22",
                fontSize: 16,
                fontWeight: 700,
                cursor: "pointer",
                width: "100%",
              }}
            >
              {t("tenant_detail.embed_issue_button")}
            </button>
          </>
        )}
      </div>

      {embedCode && (
        <div
          style={{
            marginTop: 16,
            padding: "14px 16px",
            borderRadius: 12,
            background: "rgba(59,130,246,0.1)",
            border: "1px solid rgba(96,165,250,0.2)",
            color: "#93c5fd",
            fontSize: 13,
            lineHeight: 1.6,
          }}
          dangerouslySetInnerHTML={{ __html: t("tenant_detail.embed_hint") }}
        />
      )}

      {showIssueModal && (
        <ApiKeyCreateModal
          tenantId={tenant.id}
          onSuccess={(newKey) => setIssuedKey(newKey)}
          onClose={() => setShowIssueModal(false)}
        />
      )}

      {/* ─── コンバージョン計測タグ ─── */}
      <div style={{ ...CARD_STYLE, marginTop: 16 }}>
        <p style={{ fontSize: 15, fontWeight: 700, color: "var(--foreground)", marginBottom: 8 }}>
          コンバージョン計測タグ
        </p>
        <p style={{ fontSize: 13, color: "var(--muted-foreground)", marginBottom: 16, lineHeight: 1.6 }}>
          購入完了ページや問い合わせ完了ページに追加すると、チャット経由の成果を自動で計測できます。
          ウィジェット（widget.js）を読み込んだページでのみ動作します。
        </p>

        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 6 }}>
          購入完了ページ用
        </p>
        <pre style={CODE_STYLE}>{purchaseTag}</pre>
        <button onClick={handleCopyPurchase} style={COPY_BTN_STYLE(copiedPurchase)}>
          {copiedPurchase ? "コピーしました ✓" : "コードをコピー"}
        </button>

        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--muted-foreground)", marginTop: 16, marginBottom: 6 }}>
          問い合わせ完了ページ用
        </p>
        <pre style={CODE_STYLE}>{inquiryTag}</pre>
        <button onClick={handleCopyInquiry} style={COPY_BTN_STYLE(copiedInquiry)}>
          {copiedInquiry ? "コピーしました ✓" : "コードをコピー"}
        </button>
      </div>
    </div>
  );
}
