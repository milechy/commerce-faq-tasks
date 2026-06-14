import { useState } from "react";
import { useLang } from "../../../i18n/LangContext";
import type { TenantDetail, TenantPlan } from "./types";
import { PLAN_OPTIONS } from "./types";

// ─── 課金管理セクション（Super Admin専用） ────────────────────────────────────

export function BillingSection({
  tenant,
  onUpdate,
  updateBilling,
}: {
  tenant: TenantDetail;
  onUpdate: (updated: TenantDetail) => void;
  updateBilling: (
    tenantId: string,
    billing_enabled: boolean,
    billing_free_from: string | null,
    billing_free_until: string | null,
    plan?: TenantPlan
  ) => Promise<TenantDetail>;
}) {
  const { t, lang } = useLang();
  const locale = lang === "en" ? "en-US" : "ja-JP";
  const [billingEnabled, setBillingEnabled] = useState(tenant.billing_enabled);
  const [plan, setPlan] = useState<TenantPlan>(tenant.plan);
  const [freeFromDate, setFreeFromDate] = useState<string>(
    tenant.billing_free_from ? tenant.billing_free_from.split("T")[0] : ""
  );
  const [freeUntilDate, setFreeUntilDate] = useState<string>(
    tenant.billing_free_until ? tenant.billing_free_until.split("T")[0] : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const freeFromParsed  = freeFromDate  ? new Date(freeFromDate)  : null;
  const freeUntilParsed = freeUntilDate ? new Date(freeUntilDate) : null;
  const isFreePeriodActive =
    freeFromParsed !== null && freeUntilParsed !== null &&
    now >= freeFromParsed && now <= freeUntilParsed;
  const isFreePeriodScheduled =
    freeFromParsed !== null && freeUntilParsed !== null &&
    now < freeFromParsed;

  const handleClear = () => {
    setFreeFromDate("");
    setFreeUntilDate("");
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateBilling(
        tenant.id,
        billingEnabled,
        freeFromDate  || null,
        freeUntilDate || null,
        plan
      );
      onUpdate(updated);
    } catch {
      setError(t("billing_mgmt.save_error"));
    } finally {
      setSaving(false);
    }
  };

  const dateInputStyle: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "rgba(0,0,0,0.3)",
    color: "var(--foreground)",
    fontSize: 15,
    outline: "none",
    minHeight: 44,
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "20px 18px",
        marginTop: 24,
        background: "rgba(0,0,0,0.2)",
      }}
    >
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 16px", color: "var(--foreground)" }}>
        {t("billing_mgmt.title")}
      </h3>

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

      {/* プラン選択 */}
      <div style={{ marginBottom: 20 }}>
        <p style={{ margin: "0 0 4px", fontWeight: 600, color: "var(--foreground)", fontSize: 15 }}>
          プラン
        </p>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--muted-foreground)" }}>
          対話単価にプラン倍率が適用されます（Starter ×1.0 / Growth ×1.5 / Enterprise ×2.5）。
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {PLAN_OPTIONS.map((opt) => {
            const selected = plan === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPlan(opt.value)}
                style={{
                  flex: "1 1 160px",
                  textAlign: "left",
                  padding: "12px 14px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: `1px solid ${selected ? "rgba(124,58,237,0.6)" : "var(--border)"}`,
                  background: selected ? "rgba(124,58,237,0.15)" : "rgba(255,255,255,0.02)",
                  color: "var(--foreground)",
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "block", fontWeight: 700, fontSize: 14 }}>
                  {opt.label} <span style={{ color: "#a78bfa" }}>×{opt.multiplier.toFixed(1)}</span>
                </span>
                <span style={{ display: "block", fontSize: 12, color: "var(--muted-foreground)", marginTop: 2 }}>
                  {opt.desc}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 課金ステータストグル */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "var(--foreground)", fontSize: 15 }}>
            {t("billing_mgmt.status")}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>
            {billingEnabled ? t("billing_mgmt.enabled_desc") : t("billing_mgmt.disabled_desc")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setBillingEnabled((v) => !v)}
          style={{
            padding: "10px 20px",
            minHeight: 44,
            borderRadius: 10,
            border: `1px solid ${billingEnabled ? "rgba(74,222,128,0.4)" : "rgba(107,114,128,0.4)"}`,
            background: billingEnabled ? "rgba(34,197,94,0.2)" : "rgba(107,114,128,0.2)",
            color: billingEnabled ? "#4ade80" : "#9ca3af",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {billingEnabled ? `✅ ${t("billing_mgmt.enabled")}` : `⏸️ ${t("billing_mgmt.disabled")}`}
        </button>
      </div>

      {/* 無料期間（開始日〜終了日） */}
      <div>
        <p style={{ margin: "0 0 4px", fontWeight: 600, color: "var(--foreground)", fontSize: 15 }}>
          {t("billing_mgmt.free_period")}
        </p>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted-foreground)" }}>
          {t("billing_mgmt.free_period_desc")}
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--muted-foreground)", fontWeight: 600 }}>
              {t("billing_mgmt.free_from_label")}
            </p>
            <input
              type="date"
              value={freeFromDate}
              onChange={(e) => setFreeFromDate(e.target.value)}
              style={dateInputStyle}
            />
          </div>
          <span style={{ color: "var(--muted-foreground)", fontSize: 18, paddingBottom: 10, fontWeight: 700 }}>〜</span>
          <div>
            <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--muted-foreground)", fontWeight: 600 }}>
              {t("billing_mgmt.free_until_label")}
            </p>
            <input
              type="date"
              value={freeUntilDate}
              min={freeFromDate || undefined}
              onChange={(e) => setFreeUntilDate(e.target.value)}
              style={dateInputStyle}
            />
          </div>
          {(freeFromDate || freeUntilDate) && (
            <button
              type="button"
              onClick={handleClear}
              style={{
                background: "none",
                border: "none",
                color: "#f87171",
                fontSize: 13,
                cursor: "pointer",
                paddingBottom: 10,
                minHeight: 44,
              }}
            >
              {t("billing_mgmt.clear_free")}
            </button>
          )}
        </div>

        {/* 現在無料期間中 */}
        {isFreePeriodActive && (
          <p style={{ fontSize: 13, color: "#fbbf24", marginTop: 10 }}>
            ⚠️ {t("billing_mgmt.free_period_active", {
              from:  freeFromParsed!.toLocaleDateString(locale),
              until: freeUntilParsed!.toLocaleDateString(locale),
            })}
          </p>
        )}

        {/* 将来の無料期間予約 */}
        {isFreePeriodScheduled && (
          <p style={{ fontSize: 13, color: "#60a5fa", marginTop: 10 }}>
            📅 {t("billing_mgmt.free_period_scheduled", {
              from:  freeFromParsed!.toLocaleDateString(locale),
              until: freeUntilParsed!.toLocaleDateString(locale),
            })}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        style={{
          marginTop: 20,
          padding: "12px 20px",
          minHeight: 48,
          borderRadius: 10,
          border: "none",
          background: saving ? "rgba(34,197,94,0.3)" : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: "#022c22",
          fontSize: 15,
          fontWeight: 700,
          cursor: saving ? "not-allowed" : "pointer",
          width: "100%",
        }}
      >
        {saving ? t("billing_mgmt.saving") : t("billing_mgmt.save")}
      </button>
    </div>
  );
}
