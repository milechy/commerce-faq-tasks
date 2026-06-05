import { useState } from "react";
import { useLang } from "../../../i18n/LangContext";
import type { TenantDetail, ApiKey } from "./types";
import { CARD_STYLE } from "./types";

export default function EmbedCodeTab({ tenant, apiKeys }: { tenant: TenantDetail; apiKeys: ApiKey[] }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const [copiedPurchase, setCopiedPurchase] = useState(false);
  const [copiedInquiry, setCopiedInquiry] = useState(false);

  const activeKey = apiKeys.find((k) => k.status === "active");
  const displayKey = activeKey ? activeKey.maskedKey : "YOUR_API_KEY";

  const embedCode = `<script src="https://cdn.r2c.biz/widget.js"
  data-api-key="${displayKey}"
  data-tenant="${tenant.slug}"
  data-title="${tenant.widgetTitle}"
  data-color="${tenant.widgetColor}">
</script>`;

  const purchaseTag = `<script>\n  window.r2c && r2c.trackConversion('purchase', /* 購入金額(円) */ 0);\n</script>`;
  const inquiryTag = `<script>\n  window.r2c && r2c.trackConversion('inquiry');\n</script>`;

  const handleCopy = async () => {
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
    border: "1px solid #374151",
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
        <p style={{ fontSize: 14, color: "#9ca3af", marginBottom: 16, lineHeight: 1.6 }}>
          {t("tenant_detail.embed_desc")}
        </p>
        <pre
          style={{
            fontFamily: "monospace",
            background: "rgba(0,0,0,0.5)",
            border: "1px solid #374151",
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
      </div>

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

      {/* ─── コンバージョン計測タグ ─── */}
      <div style={{ ...CARD_STYLE, marginTop: 16 }}>
        <p style={{ fontSize: 15, fontWeight: 700, color: "#f9fafb", marginBottom: 8 }}>
          コンバージョン計測タグ
        </p>
        <p style={{ fontSize: 13, color: "#9ca3af", marginBottom: 16, lineHeight: 1.6 }}>
          購入完了ページや問い合わせ完了ページに追加すると、チャット経由の成果を自動で計測できます。
          ウィジェット（widget.js）を読み込んだページでのみ動作します。
        </p>

        <p style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db", marginBottom: 6 }}>
          購入完了ページ用
        </p>
        <pre style={CODE_STYLE}>{purchaseTag}</pre>
        <button onClick={handleCopyPurchase} style={COPY_BTN_STYLE(copiedPurchase)}>
          {copiedPurchase ? "コピーしました ✓" : "コードをコピー"}
        </button>

        <p style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db", marginTop: 16, marginBottom: 6 }}>
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
