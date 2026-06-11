import type { NavigateFunction } from "react-router-dom";
import LangSwitcher from "../../../components/LangSwitcher";
import type { TranslationKey } from "../../../i18n/ja";
import type { TenantDetail } from "./types";

// ─── ヘッダー ─────────────────────────────────────────────────────────────────

export function TenantDetailHeader({
  loading,
  tenant,
  navigate,
  handleEnterPreview,
  t,
}: {
  loading: boolean;
  tenant: TenantDetail | null;
  navigate: NavigateFunction;
  handleEnterPreview: () => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <header style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <button
          onClick={() => navigate("/admin/tenants")}
          style={{
            padding: "8px 14px",
            minHeight: 44,
            borderRadius: 999,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--muted-foreground)",
            fontSize: 14,
            cursor: "pointer",
            fontWeight: 500,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {t("tenant_detail.back")}
        </button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {tenant && (
            <button
              onClick={handleEnterPreview}
              style={{
                padding: "8px 14px",
                minHeight: 44,
                borderRadius: 999,
                border: "1px solid rgba(234,179,8,0.4)",
                background: "rgba(234,179,8,0.1)",
                color: "#fbbf24",
                fontSize: 14,
                cursor: "pointer",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {t("preview.enter")}
            </button>
          )}
          <LangSwitcher />
        </div>
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 700, margin: "0 0 4px", color: "var(--foreground)" }}>
        {loading ? t("tenant_detail.loading") : (tenant?.name ?? t("tenant_detail.not_found"))}
      </h1>
      {tenant && tenant.slug && (
        <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: 0 }}>
          slug: <span style={{ fontFamily: "monospace" }}>{tenant.slug}</span>
        </p>
      )}
    </header>
  );
}
