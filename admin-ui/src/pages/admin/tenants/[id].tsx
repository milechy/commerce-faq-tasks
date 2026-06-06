import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { API_BASE } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";
import { useAuth } from "../../../auth/useAuth";
import AIReportTab from "../../../components/admin/AIReportTab";
import ABTestTab from "../../../components/admin/ABTestTab";
import ObjectionPatternsTab from "../../../components/admin/ObjectionPatternsTab";
import TenantTuningTab from "../../../components/admin/TenantTuningTab";
import TenantTestTab from "../../../components/admin/TenantTestTab";
import PostHogIntegrationTab from "./PostHogIntegrationTab";
import Ga4IntegrationTab from "./Ga4IntegrationTab";
import ApiKeysTab, { fetchApiKeys } from "./ApiKeysTab";
import EmbedCodeTab from "./EmbedCodeTab";
import DeepResearchTab from "./DeepResearchTab";
import ConversionTypesTab from "./ConversionTypesTab";
import AnalyticsSummaryTab from "./AnalyticsSummaryTab";
import BillingInfoTab from "./BillingInfoTab";
import NotificationPreferencesTab from "./NotificationPreferencesTab";
import type { TenantFeatures, TenantDetail, ApiKey } from "./types";
import { CARD_STYLE } from "./types";

// ─── 型定義 (TenantFeatures, TenantDetail, ApiKey は ./types に移動) ──────────

// ─── 認証ヘルパー ─────────────────────────────────────────────────────────────

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  const { data: refreshed } = await supabase.auth.refreshSession();
  return refreshed.session?.access_token ?? null;
}

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  if (!token) throw new Error("__AUTH_REQUIRED__");
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string>),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

// ─── API関数 ─────────────────────────────────────────────────────────────────

async function fetchTenantDetail(tenantId: string): Promise<TenantDetail> {
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await res.json()) as any;
  const data = "tenant" in raw ? raw.tenant : raw;
  // DB returns is_active: boolean; map to status: "active" | "inactive"
  return {
    ...data,
    status: data.is_active ? "active" : "inactive",
    allowed_origins: data.allowed_origins ?? [],
    billing_enabled: data.billing_enabled ?? false,
    billing_free_from: data.billing_free_from ?? null,
    billing_free_until: data.billing_free_until ?? null,
    features: data.features ?? { avatar: false, voice: false, rag: true },
    lemonslice_agent_id: data.lemonslice_agent_id ?? null,
    conversion_types: data.conversion_types ?? ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"],
  } as TenantDetail;
}

async function updateTenant(
  tenantId: string,
  data: { name: string; status: "active" | "inactive"; allowed_origins: string[]; system_prompt?: string; tenant_contact_email?: string | null }
): Promise<TenantDetail> {
  // Backend expects is_active: boolean (not status string)
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: data.name,
      is_active: data.status === "active",
      allowed_origins: data.allowed_origins,
      system_prompt: data.system_prompt ?? "",
      tenant_contact_email: data.tenant_contact_email,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await res.json()) as any;
  const json = "tenant" in raw ? raw.tenant : raw;
  return {
    ...json,
    status: json.is_active ? "active" : "inactive",
    allowed_origins: json.allowed_origins ?? [],
    billing_enabled: json.billing_enabled ?? false,
    billing_free_from: json.billing_free_from ?? null,
    billing_free_until: json.billing_free_until ?? null,
    features: json.features ?? { avatar: false, voice: false, rag: true },
    lemonslice_agent_id: json.lemonslice_agent_id ?? null,
  } as TenantDetail;
}

async function updateAvatarSettings(
  tenantId: string,
  features: TenantFeatures,
  lemonslice_agent_id: string | null
): Promise<TenantDetail> {
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}`, {
    method: "PATCH",
    body: JSON.stringify({ features, lemonslice_agent_id }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await res.json()) as any;
  const json = "tenant" in raw ? raw.tenant : raw;
  return {
    ...json,
    status: json.is_active ? "active" : "inactive",
    allowed_origins: json.allowed_origins ?? [],
    billing_enabled: json.billing_enabled ?? false,
    billing_free_from: json.billing_free_from ?? null,
    billing_free_until: json.billing_free_until ?? null,
    features: json.features ?? { avatar: false, voice: false, rag: true },
    lemonslice_agent_id: json.lemonslice_agent_id ?? null,
  } as TenantDetail;
}

async function updateBilling(
  tenantId: string,
  billing_enabled: boolean,
  billing_free_from: string | null,
  billing_free_until: string | null
): Promise<TenantDetail> {
  const body: Record<string, unknown> = {
    billing_enabled,
    // null でも明示的に送信してクリアできるようにする
    billing_free_from:  billing_free_from  ? new Date(billing_free_from).toISOString()  : null,
    billing_free_until: billing_free_until ? new Date(billing_free_until).toISOString() : null,
  };
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = (await res.json()) as any;
  const json = "tenant" in raw ? raw.tenant : raw;
  return {
    ...json,
    status: json.is_active ? "active" : "inactive",
    allowed_origins: json.allowed_origins ?? [],
    billing_enabled: json.billing_enabled ?? false,
    billing_free_from: json.billing_free_from ?? null,
    billing_free_until: json.billing_free_until ?? null,
    features: json.features ?? { avatar: false, voice: false, rag: true },
    lemonslice_agent_id: json.lemonslice_agent_id ?? null,
  } as TenantDetail;
}

// ─── スタイル定数 (CARD_STYLE は ./types に移動) ─────────────────────────────

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(0,0,0,0.3)",
  color: "#f9fafb",
  fontSize: 16,
  outline: "none",
  boxSizing: "border-box",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#9ca3af",
  marginBottom: 6,
};

// ─── タブ: アバター設定 ────────────────────────────────────────────────────────

function AvatarTab({
  tenant,
  onUpdate,
}: {
  tenant: TenantDetail;
  onUpdate: (updated: TenantDetail) => void;
}) {
  const { t } = useLang();
  const [avatarEnabled, setAvatarEnabled] = useState(tenant.features.avatar);
  const [voiceEnabled, setVoiceEnabled] = useState(tenant.features.voice);
  const [agentId, setAgentId] = useState(tenant.lemonslice_agent_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateAvatarSettings(
        tenant.id,
        { avatar: avatarEnabled, voice: voiceEnabled, rag: tenant.features.rag },
        agentId.trim() || null
      );
      onUpdate(updated);
    } catch {
      setError("保存に失敗しました。もう一度お試しください 🙏");
    } finally {
      setSaving(false);
    }
  };

  const toggleStyle = (on: boolean, disabled?: boolean): React.CSSProperties => ({
    padding: "10px 20px",
    minHeight: 44,
    borderRadius: 10,
    border: `1px solid ${on ? "rgba(74,222,128,0.4)" : "rgba(107,114,128,0.4)"}`,
    background: on ? "rgba(34,197,94,0.2)" : "rgba(107,114,128,0.2)",
    color: disabled ? "#4b5563" : on ? "#4ade80" : "#9ca3af",
    fontSize: 14,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ヘッダー説明 */}
      <div
        style={{
          padding: "16px 18px",
          borderRadius: 12,
          background: "rgba(59,130,246,0.08)",
          border: "1px solid rgba(96,165,250,0.2)",
          color: "#93c5fd",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <p style={{ margin: "0 0 4px", fontWeight: 700, color: "#bfdbfe", fontSize: 14 }}>
          🤖 AIアバター（有料オプション）
        </p>
        お客様との会話にAIアバターを表示します。LiveKitによるリアルタイム映像で、より親しみやすい接客を実現します。
      </div>

      {error && (
        <div
          style={{
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

      {/* AIアバタートグル */}
      <div
        style={{
          ...CARD_STYLE,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#e5e7eb", fontSize: 15 }}>
            AIアバターを有効にする
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>
            {avatarEnabled ? "アバター表示が有効（Widget側で表示されます）" : "現在はテキストチャットのみ"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const next = !avatarEnabled;
            setAvatarEnabled(next);
            if (!next) setVoiceEnabled(false);
          }}
          style={toggleStyle(avatarEnabled)}
        >
          {avatarEnabled ? "✅ 有効" : "⏸️ 無効"}
        </button>
      </div>

      {/* 音声会話トグル */}
      <div
        style={{
          ...CARD_STYLE,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          opacity: avatarEnabled ? 1 : 0.6,
        }}
      >
        <div>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#e5e7eb", fontSize: 15 }}>
            音声会話を有効にする
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>
            {!avatarEnabled
              ? "AIアバターを有効にすると使用できます"
              : voiceEnabled
              ? "お客様がマイクで話しかけられます"
              : "テキスト入力のみ（マイク不使用）"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { if (avatarEnabled) setVoiceEnabled((v) => !v); }}
          disabled={!avatarEnabled}
          style={toggleStyle(voiceEnabled, !avatarEnabled)}
        >
          {voiceEnabled ? "🎤 有効" : "⏸️ 無効"}
        </button>
      </div>

      {/* Lemonslice Agent ID */}
      <div style={CARD_STYLE}>
        <label style={LABEL_STYLE}>Lemonslice Agent ID</label>
        <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 8px", lineHeight: 1.5 }}>
          Lemonslice管理画面で発行したエージェントIDを入力してください。空欄の場合はアバターが起動しません。
        </p>
        <input
          type="text"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="例: agent_xxxxxxxxxxxxxxxx"
          style={{ ...INPUT_STYLE, fontFamily: "monospace", fontSize: 14 }}
        />
      </div>

      <button
        type="button"
        onClick={handleSave}
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
        {saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  );
}

// ─── 課金管理セクション（Super Admin専用） ────────────────────────────────────

function BillingSection({
  tenant,
  onUpdate,
}: {
  tenant: TenantDetail;
  onUpdate: (updated: TenantDetail) => void;
}) {
  const { t, lang } = useLang();
  const locale = lang === "en" ? "en-US" : "ja-JP";
  const [billingEnabled, setBillingEnabled] = useState(tenant.billing_enabled);
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
        freeUntilDate || null
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
    border: "1px solid #374151",
    background: "rgba(0,0,0,0.3)",
    color: "#f9fafb",
    fontSize: 15,
    outline: "none",
    minHeight: 44,
  };

  return (
    <div
      style={{
        border: "1px solid #374151",
        borderRadius: 12,
        padding: "20px 18px",
        marginTop: 24,
        background: "rgba(0,0,0,0.2)",
      }}
    >
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 16px", color: "#f9fafb" }}>
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
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#e5e7eb", fontSize: 15 }}>
            {t("billing_mgmt.status")}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>
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
        <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#e5e7eb", fontSize: 15 }}>
          {t("billing_mgmt.free_period")}
        </p>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: "#9ca3af" }}>
          {t("billing_mgmt.free_period_desc")}
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <p style={{ margin: "0 0 6px", fontSize: 12, color: "#9ca3af", fontWeight: 600 }}>
              {t("billing_mgmt.free_from_label")}
            </p>
            <input
              type="date"
              value={freeFromDate}
              onChange={(e) => setFreeFromDate(e.target.value)}
              style={dateInputStyle}
            />
          </div>
          <span style={{ color: "#6b7280", fontSize: 18, paddingBottom: 10, fontWeight: 700 }}>〜</span>
          <div>
            <p style={{ margin: "0 0 6px", fontSize: 12, color: "#9ca3af", fontWeight: 600 }}>
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

// ─── タブ: 設定 ───────────────────────────────────────────────────────────────

function SettingsTab({
  tenant,
  isSuperAdmin,
  onSave,
  onBillingUpdate,
}: {
  tenant: TenantDetail;
  isSuperAdmin: boolean;
  onSave: (data: { name: string; status: "active" | "inactive"; allowed_origins: string[]; system_prompt?: string; tenant_contact_email?: string | null }) => Promise<void>;
  onBillingUpdate: (updated: TenantDetail) => void;
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
                  border: status === s ? `1px solid ${s === "active" ? "#4ade80" : "#9ca3af"}` : "1px solid #374151",
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
          <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 8px", lineHeight: 1.5 }}>
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
          <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0", textAlign: "right" }}>
            {systemPrompt.length} / 5000
          </p>
        </div>

        <div>
          <label style={LABEL_STYLE}>担当者メールアドレス</label>
          <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 8px", lineHeight: 1.5 }}>
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
        <BillingSection tenant={tenant} onUpdate={onBillingUpdate} />
      )}
    </form>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

type TabId = "settings" | "apikeys" | "embed" | "avatar" | "ai-report" | "ab-test" | "objection-patterns" | "conversion" | "deep-research" | "tuning" | "test" | "ga4" | "posthog" | "analytics" | "billing-info" | "notification-prefs";

export default function TenantDetailPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { id } = useParams<{ id: string }>();
  const tenantId = id ?? "1";
  const { enterPreview, isSuperAdmin } = useAuth();

  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("settings");
  const [toast, setToast] = useState<string | null>(null);
  const [unreadReportCount, setUnreadReportCount] = useState(0);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [tenantData, keysData] = await Promise.all([
          fetchTenantDetail(tenantId),
          fetchApiKeys(tenantId),
        ]);
        setTenant(tenantData);
        setApiKeys(keysData);
      } catch (err) {
        if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
          navigate("/login", { replace: true });
          return;
        }
        // tenant not found — leave null
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [tenantId, navigate]);

  const handleSaveSettings = async (data: {
    name: string;
    status: "active" | "inactive";
    allowed_origins: string[];
    system_prompt?: string;
    tenant_contact_email?: string | null;
  }) => {
    const updated = await updateTenant(tenantId, data);
    setTenant(updated);
    showToast(t("tenant_detail.saved"));
  };

  const handleEnterPreview = () => {
    if (!tenant) return;
    enterPreview(tenantId, tenant.name);
    navigate("/admin");
  };

  // 未読レポート数の取得
  useEffect(() => {
    const fetchUnread = async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch(`${API_BASE}/v1/admin/reports/unread-count?tenantId=${tenantId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = (await res.json()) as any;
          setUnreadReportCount(data.count ?? 0);
        }
      } catch {
        // API未実装の場合はモック値
        setUnreadReportCount(1);
      }
    };
    void fetchUnread();
  }, [tenantId]);

  const aiReportLabel = (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 4 }}>
      📊 AI改善レポート
      {unreadReportCount > 0 && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 18,
            height: 18,
            borderRadius: 999,
            background: "#ef4444",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            padding: "0 4px",
          }}
        >
          {unreadReportCount}
        </span>
      )}
    </span>
  );

  const baseTabs: { id: TabId; label: React.ReactNode }[] = [
    { id: "settings", label: t("tenant_detail.tab_settings") },
    { id: "apikeys", label: t("tenant_detail.tab_apikeys") },
    { id: "embed", label: t("tenant_detail.tab_embed") },
    { id: "avatar", label: "🤖 アバター" },
    { id: "ga4", label: "📊 GA4連携" },
    { id: "posthog", label: "📈 PostHog連携" },
    { id: "analytics", label: "📉 アナリティクス" },
    { id: "billing-info", label: "💳 請求情報" },
    { id: "notification-prefs", label: "🔔 通知設定" },
    { id: "ai-report", label: aiReportLabel },
    { id: "conversion", label: "🎯 成果設定" },
    { id: "deep-research", label: "🔬 ディープリサーチ" },
    { id: "tuning", label: "🎛 チューニング" },
    { id: "test", label: "💬 テスト" },
  ];

  const TABS: { id: TabId; label: React.ReactNode }[] = isSuperAdmin
    ? [
        ...baseTabs,
        { id: "ab-test", label: "🔬 A/Bテスト" },
        { id: "objection-patterns", label: "💬 反論パターン" },
      ]
    : baseTabs;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      {/* トースト */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "14px 24px",
            borderRadius: 12,
            background: "rgba(15,23,42,0.98)",
            border: "1px solid #22c55e",
            color: "#4ade80",
            fontSize: 15,
            fontWeight: 600,
            zIndex: 2000,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap",
          }}
        >
          {toast}
        </div>
      )}

      {/* ヘッダー */}
      <header style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
          <button
            onClick={() => navigate("/admin/tenants")}
            style={{
              padding: "8px 14px",
              minHeight: 44,
              borderRadius: 999,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
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
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: "0 0 4px", color: "#f9fafb" }}>
          {loading ? t("tenant_detail.loading") : (tenant?.name ?? t("tenant_detail.not_found"))}
        </h1>
        {tenant && tenant.slug && (
          <p style={{ fontSize: 14, color: "#9ca3af", margin: 0 }}>
            slug: <span style={{ fontFamily: "monospace" }}>{tenant.slug}</span>
          </p>
        )}
      </header>

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 120,
            color: "#9ca3af",
            fontSize: 15,
          }}
        >
          <span style={{ marginRight: 8 }}>⏳</span>
          {t("common.loading")}
        </div>
      ) : tenant ? (
        <>
          {/* タブナビゲーション */}
          <div
            style={{
              overflowX: "auto",
              marginBottom: 24,
              background: "rgba(15,23,42,0.8)",
              border: "1px solid #1f2937",
              borderRadius: 12,
              padding: 4,
              WebkitOverflowScrolling: "touch" as const,
            }}
          >
            <div style={{ display: "flex", gap: 4, minWidth: "max-content" }}>
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    padding: "12px 16px",
                    minHeight: 44,
                    whiteSpace: "nowrap",
                    borderRadius: 10,
                    border: "none",
                    background: activeTab === tab.id ? "rgba(34,197,94,0.15)" : "transparent",
                    color: activeTab === tab.id ? "#4ade80" : "#9ca3af",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* タブコンテンツ */}
          {activeTab === "settings" && (
            <SettingsTab
              tenant={tenant}
              isSuperAdmin={isSuperAdmin}
              onSave={handleSaveSettings}
              onBillingUpdate={(updated) => { setTenant(updated); showToast(t("billing_mgmt.saved")); }}
            />
          )}
          {activeTab === "apikeys" && (
            <ApiKeysTab tenantId={tenantId} />
          )}
          {activeTab === "embed" && (
            <EmbedCodeTab tenant={tenant} apiKeys={apiKeys} />
          )}
          {activeTab === "avatar" && (
            <AvatarTab
              tenant={tenant}
              onUpdate={(updated) => { setTenant(updated); showToast("✅ アバター設定を保存しました"); }}
            />
          )}
          {activeTab === "ga4" && (
            <Ga4IntegrationTab tenantId={tenantId} />
          )}
          {activeTab === "posthog" && (
            <PostHogIntegrationTab tenantId={tenantId} />
          )}
          {activeTab === "analytics" && (
            <AnalyticsSummaryTab tenantId={tenantId} />
          )}
          {activeTab === "billing-info" && tenant && (
            <BillingInfoTab tenant={tenant} />
          )}
          {activeTab === "notification-prefs" && (
            <NotificationPreferencesTab tenantId={tenantId} />
          )}
          {activeTab === "ai-report" && (
            <AIReportTab tenantId={tenantId} />
          )}
          {activeTab === "ab-test" && isSuperAdmin && (
            <ABTestTab tenantId={tenantId} />
          )}
          {activeTab === "objection-patterns" && isSuperAdmin && (
            <ObjectionPatternsTab tenantId={tenantId} />
          )}
          {activeTab === "conversion" && tenant && (
            <ConversionTypesTab
              tenant={tenant}
              onUpdate={(updated) => { setTenant(updated); showToast("✅ コンバージョンタイプを保存しました"); }}
            />
          )}
          {activeTab === "deep-research" && tenant && (
            <DeepResearchTab
              tenant={tenant}
              onUpdate={(updated) => setTenant(updated)}
              showToast={showToast}
            />
          )}
          {activeTab === "tuning" && tenant && (
            <TenantTuningTab tenantId={tenantId} tenantName={tenant.name} />
          )}
          {activeTab === "test" && tenant && (
            <TenantTestTab tenantId={tenantId} tenantName={tenant.name} />
          )}
        </>
      ) : (
        <div
          style={{
            padding: "32px 20px",
            borderRadius: 14,
            border: "1px solid #1f2937",
            background: "rgba(127,29,29,0.2)",
            color: "#fca5a5",
            textAlign: "center",
            fontSize: 15,
          }}
        >
          {t("tenant_detail.not_found")}
        </div>
      )}
    </div>
  );
}
