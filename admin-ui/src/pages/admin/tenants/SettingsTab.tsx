import { useState } from "react";
import { useLang } from "../../../i18n/LangContext";
import { BillingSection } from "./BillingSection";
import type { TenantDetail } from "./types";
import { CARD_STYLE, INPUT_STYLE, LABEL_STYLE } from "./types";

// ─── タブ: 設定 ───────────────────────────────────────────────────────────────

export function SettingsTab({
  tenant,
  isSuperAdmin,
  onSave,
  onBillingUpdate,
  updateBilling,
}: {
  tenant: TenantDetail;
  isSuperAdmin: boolean;
  onSave: (data: { name: string; status: "active" | "inactive"; allowed_origins: string[]; system_prompt?: string; tenant_contact_email?: string | null }) => Promise<void>;
  onBillingUpdate: (updated: TenantDetail) => void;
  updateBilling: (
    tenantId: string,
    billing_enabled: boolean,
    billing_free_from: string | null,
    billing_free_until: string | null
  ) => Promise<TenantDetail>;
}) {
  const { t } = useLang();
  const [name, setName] = useState(tenant.name);
  const [status, setStatus] = useState<"active" | "inactive">(tenant.status);
  const [originsText, setOriginsText] = useState((tenant.allowed_origins ?? []).join("\n"));
  const [systemPrompt, setSystemPrompt] = useState(tenant.system_prompt ?? "");
  const [contactEmail, setContactEmail] = useState(tenant.tenant_contact_email ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseOrigins = (raw: string): string[] =>
    raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const allowed_origins = parseOrigins(originsText);
    const invalid = allowed_origins.filter((u) => !u.startsWith("https://"));
    if (invalid.length > 0) {
      setError(`URLはhttps://で始まる必要があります: ${invalid[0]}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), status, allowed_origins, system_prompt: systemPrompt, tenant_contact_email: contactEmail.trim() || null });
    } catch {
      setError(t("tenant_detail.save_error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave}>
      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: "12px 16px",
            borderRadius: 10,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ ...CARD_STYLE, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <label style={LABEL_STYLE}>{t("tenant_detail.settings_name_label")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={INPUT_STYLE}
            required
          />
        </div>

        <div>
          <label style={LABEL_STYLE}>{t("tenant_detail.settings_status_label")}</label>
          <div style={{ display: "flex", gap: 12 }}>
            {(["active", "inactive"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: status === s ? `1px solid ${s === "active" ? "#4ade80" : "#9ca3af"}` : "1px solid var(--border)",
                  background: status === s
                    ? s === "active" ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.15)"
                    : "rgba(0,0,0,0.3)",
                  color: status === s
                    ? s === "active" ? "#4ade80" : "#d1d5db"
                    : "#9ca3af",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {s === "active" ? t("tenant_detail.status_active") : t("tenant_detail.status_inactive")}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={LABEL_STYLE}>{t("tenant_detail.allowed_origins_label")}</label>
          <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "0 0 8px", lineHeight: 1.5 }}>
            {t("tenant_detail.allowed_origins_desc")}
          </p>
          <textarea
            value={originsText}
            onChange={(e) => setOriginsText(e.target.value)}
            placeholder={t("tenant_detail.allowed_origins_placeholder")}
            rows={4}
            style={{
              ...INPUT_STYLE,
              fontFamily: "monospace",
              fontSize: 13,
              resize: "vertical",
            }}
          />
        </div>

        <div>
          <label style={LABEL_STYLE}>{t("tenant_detail.system_prompt_label")}</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t("tenant_detail.system_prompt_placeholder")}
            rows={6}
            maxLength={5000}
            style={{
              ...INPUT_STYLE,
              fontSize: 14,
              resize: "vertical",
              lineHeight: 1.6,
            }}
          />
          <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "4px 0 0", textAlign: "right" }}>
            {systemPrompt.length} / 5000
          </p>
        </div>

        <div>
          <label style={LABEL_STYLE}>担当者メールアドレス</label>
          <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "0 0 8px", lineHeight: 1.5 }}>
            GA4エラー通知・請求通知の送信先
          </p>
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="contact@example.com"
            style={INPUT_STYLE}
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          style={{
            padding: "16px 24px",
            minHeight: 56,
            borderRadius: 12,
            border: "none",
            background: saving
              ? "rgba(34,197,94,0.3)"
              : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
            color: "#022c22",
            fontSize: 17,
            fontWeight: 700,
            cursor: saving ? "not-allowed" : "pointer",
            width: "100%",
          }}
        >
          {saving ? t("tenant_detail.saving") : t("tenant_detail.save_settings")}
        </button>
      </div>

      {/* 課金管理セクション — Super Admin専用 */}
      {isSuperAdmin && (
        <BillingSection tenant={tenant} onUpdate={onBillingUpdate} updateBilling={updateBilling} />
      )}
    </form>
  );
}
