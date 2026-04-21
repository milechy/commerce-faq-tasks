import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import ApiKeyCreateModal from "../../../components/ApiKeyCreateModal";
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

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface TenantFeatures {
  avatar: boolean;
  voice: boolean;
  rag: boolean;
  deep_research?: boolean;
}

interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "pro";
  status: "active" | "inactive";
  createdAt: string;
  widgetTitle: string;
  widgetColor: string;
  allowed_origins: string[];
  system_prompt?: string | null;
  billing_enabled: boolean;
  billing_free_from: string | null;
  billing_free_until: string | null;
  features: TenantFeatures;
  lemonslice_agent_id: string | null;
  conversion_types: string[];
  // Phase A: GA4連携
  ga4_property_id?: string | null;
  ga4_status?: "not_configured" | "pending" | "connected" | "error" | "timeout" | "permission_revoked" | null;
  ga4_connected_at?: string | null;
  ga4_last_sync_at?: string | null;
  ga4_error_message?: string | null;
  tenant_contact_email?: string | null;
}

interface ApiKey {
  id: string;
  maskedKey: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
}

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

async function updateDeepResearchSettings(
  tenantId: string,
  deepResearch: boolean,
  currentFeatures: TenantFeatures
): Promise<TenantDetail> {
  const features: TenantFeatures = { ...currentFeatures, deep_research: deepResearch };
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}`, {
    method: "PATCH",
    body: JSON.stringify({ features }),
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
    features: json.features ?? { avatar: false, voice: false, rag: true, deep_research: false },
    lemonslice_agent_id: json.lemonslice_agent_id ?? null,
  } as TenantDetail;
}

async function fetchApiKeys(tenantId: string): Promise<ApiKey[]> {
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/keys`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    keys?: Array<{ id: string; key_prefix: string; prefix?: string; is_active: boolean; created_at: string; last_used_at: string | null }>;
  };
  return (data.keys ?? []).map((k) => ({
    id: k.id,
    maskedKey: k.prefix ?? (k.key_prefix + "****"),
    status: k.is_active ? "active" : "revoked",
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
  }));
}

async function revokeApiKey(tenantId: string, keyId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/keys/${keyId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
};

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

// ─── タブ: APIキー ────────────────────────────────────────────────────────────

function ApiKeysTab({ tenantId }: { tenantId: string }) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const locale = lang === "en" ? "en-US" : "ja-JP";
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [copiedPrefixId, setCopiedPrefixId] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await fetchApiKeys(tenantId);
        setKeys(data);
      } catch (err) {
        if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
          navigate("/login", { replace: true });
        }
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [tenantId, navigate]);

  const handleRevoke = async (keyId: string) => {
    if (!window.confirm(t("tenant_detail.revoke_confirm"))) return;
    setRevoking(keyId);
    try {
      await revokeApiKey(tenantId, keyId);
      setKeys((prev) =>
        prev.map((k) => (k.id === keyId ? { ...k, status: "revoked" as const } : k))
      );
      showToast(t("tenant_detail.revoke_success"));
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      showToast(t("tenant_detail.revoke_error"));
    } finally {
      setRevoking(null);
    }
  };

  const handleKeyIssued = (newKey: string) => {
    const newEntry: ApiKey = {
      id: `k_${Date.now()}`,
      maskedKey: `${newKey.slice(0, 16)}...****`,
      status: "active",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    setKeys((prev) => [newEntry, ...prev]);
    showToast(t("tenant_detail.key_issued"));
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div>
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

      <button
        onClick={() => setShowModal(true)}
        style={{
          width: "100%",
          padding: "16px 24px",
          minHeight: 56,
          borderRadius: 12,
          border: "none",
          background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: "#022c22",
          fontSize: 16,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          marginBottom: 20,
        }}
      >
        {t("tenant_detail.issue_key")}
      </button>

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 80,
            color: "#9ca3af",
            fontSize: 15,
          }}
        >
          <span style={{ marginRight: 8 }}>⏳</span>
          {t("tenant_detail.key_loading")}
        </div>
      ) : keys.length === 0 ? (
        <div
          style={{
            ...CARD_STYLE,
            textAlign: "center",
            color: "#6b7280",
            fontSize: 15,
            padding: "32px 20px",
          }}
        >
          {t("tenant_detail.key_empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {keys.map((key) => (
            <div
              key={key.id}
              style={{
                ...CARD_STYLE,
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <button
                    title="プレフィックスをコピー（識別用）"
                    onClick={() => {
                      const prefix = key.maskedKey;
                      const doCopy = async () => {
                        let ok = false;
                        try {
                          await navigator.clipboard.writeText(prefix);
                          ok = true;
                        } catch {
                          try {
                            const inp = document.createElement("input");
                            inp.value = prefix;
                            inp.style.position = "fixed";
                            inp.style.opacity = "0";
                            document.body.appendChild(inp);
                            inp.select();
                            ok = document.execCommand("copy");
                            document.body.removeChild(inp);
                          } catch { /* ignore */ }
                        }
                        if (ok) {
                          setCopiedPrefixId(key.id);
                          setTimeout(() => setCopiedPrefixId(null), 2000);
                        }
                      };
                      void doCopy();
                    }}
                    style={{
                      fontFamily: "monospace",
                      fontSize: 14,
                      color: copiedPrefixId === key.id ? "#4ade80" : "#86efac",
                      wordBreak: "break-all",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "copy",
                      textAlign: "left",
                    }}
                  >
                    {copiedPrefixId === key.id ? "✅ コピー済み" : key.maskedKey}
                  </button>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 700,
                      background: key.status === "active" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                      color: key.status === "active" ? "#4ade80" : "#f87171",
                      border: `1px solid ${key.status === "active" ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {key.status === "active" ? t("tenant_detail.key_status_active") : t("tenant_detail.key_status_revoked")}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <span>{t("tenant_detail.key_created_at", { date: formatDate(key.createdAt) })}</span>
                  <span>
                    {key.lastUsedAt
                      ? t("tenant_detail.key_last_used", { date: formatDate(key.lastUsedAt) })
                      : t("tenant_detail.key_never_used")}
                  </span>
                </div>
              </div>

              {key.status === "active" && (
                <button
                  onClick={() => handleRevoke(key.id)}
                  disabled={revoking === key.id}
                  style={{
                    padding: "10px 16px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid rgba(239,68,68,0.4)",
                    background: "rgba(239,68,68,0.1)",
                    color: "#f87171",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: revoking === key.id ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {revoking === key.id ? t("tenant_detail.revoking") : t("tenant_detail.revoke")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <ApiKeyCreateModal
          tenantId={tenantId}
          onClose={() => setShowModal(false)}
          onSuccess={handleKeyIssued}
        />
      )}
    </div>
  );
}

// ─── タブ: 埋め込みコード ──────────────────────────────────────────────────────

function EmbedCodeTab({ tenant, apiKeys }: { tenant: TenantDetail; apiKeys: ApiKey[] }) {
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

// ─── ディープリサーチ設定タブ ─────────────────────────────────────────────────

function DeepResearchTab({
  tenant,
  onUpdate,
  showToast,
}: {
  tenant: TenantDetail;
  onUpdate: (updated: TenantDetail) => void;
  showToast: (msg: string) => void;
}) {
  const [deepResearch, setDeepResearch] = useState<boolean>(tenant.features.deep_research ?? false);
  const [saving, setSaving] = useState(false);
  const [confirmPending, setConfirmPending] = useState(false);

  const handleToggle = async () => {
    const next = !deepResearch;
    if (next) {
      // ON切り替え → 確認ダイアログ
      setConfirmPending(true);
      return;
    }
    // OFF切り替え → 即座に反映
    await save(false);
  };

  const save = async (value: boolean) => {
    setSaving(true);
    try {
      const updated = await updateDeepResearchSettings(tenant.id, value, tenant.features);
      setDeepResearch(value);
      onUpdate(updated);
      showToast("✅ 設定を保存しました");
    } catch {
      showToast("❌ 保存に失敗しました。もう一度お試しください");
    } finally {
      setSaving(false);
      setConfirmPending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box" }}>
      {/* 確認ダイアログ */}
      {confirmPending && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            style={{
              background: "#111827", borderRadius: 14,
              border: "1px solid #374151",
              padding: "28px 24px", maxWidth: 400, width: "100%",
            }}
          >
            <p style={{ color: "#e5e7eb", fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>
              ディープリサーチをONにしますか？
            </p>
            <p style={{ color: "#9ca3af", fontSize: 13, margin: "0 0 24px", lineHeight: 1.6 }}>
              ディープリサーチをONにすると、追加コスト（月$3〜8程度）が発生します。よろしいですか？
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setConfirmPending(false)}
                style={{
                  padding: "10px 18px", borderRadius: 8,
                  border: "1px solid #374151", background: "transparent",
                  color: "#9ca3af", fontSize: 14, cursor: "pointer",
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => save(true)}
                disabled={saving}
                style={{
                  padding: "10px 18px", borderRadius: 8,
                  border: "none", background: saving ? "#1f2937" : "#1d4ed8",
                  color: saving ? "#6b7280" : "#fff",
                  fontSize: 14, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                {saving ? "保存中..." : "ONにする"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* メインカード */}
      <div
        style={{
          ...CARD_STYLE,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexWrap: "wrap", gap: 16,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#e5e7eb", fontSize: 15 }}>
            🔬 ディープリサーチ（AI提案の精度向上）
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>
            AIの改善提案に最新の市場動向・心理学研究を反映します
          </p>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          disabled={saving}
          aria-label="ディープリサーチ切り替え"
          style={{
            position: "relative",
            display: "inline-flex", alignItems: "center",
            width: 56, height: 32, borderRadius: 16,
            border: "none",
            background: deepResearch ? "#2563eb" : "#374151",
            cursor: saving ? "not-allowed" : "pointer",
            transition: "background 0.2s", flexShrink: 0,
            opacity: saving ? 0.6 : 1,
          }}
        >
          <span
            style={{
              display: "inline-block", width: 24, height: 24, borderRadius: "50%",
              background: "#fff",
              transform: deepResearch ? "translateX(28px)" : "translateX(4px)",
              transition: "transform 0.2s",
            }}
          />
        </button>
      </div>

      {/* ONにすると何が実現できるか */}
      <div
        style={{
          borderRadius: 12,
          border: "1px solid rgba(96,165,250,0.3)",
          background: "rgba(29,78,216,0.1)",
          padding: "16px 18px",
        }}
      >
        <p style={{ margin: "0 0 8px", fontWeight: 600, color: "#93c5fd", fontSize: 13 }}>
          ONにすると：
        </p>
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {[
            "チューニングルール提案に最新の業界動向が反映されます",
            "ナレッジの穴の推薦精度が向上します",
            "管理画面AIアシスタントが外部の知見も参照します",
          ].map((item, i) => (
            <li key={i} style={{ color: "#bfdbfe", fontSize: 13 }}>・{item}</li>
          ))}
        </ul>
      </div>

      {/* コスト説明 */}
      <div
        style={{
          borderRadius: 10,
          border: "1px solid #1f2937",
          background: "rgba(17,24,39,0.5)",
          padding: "12px 16px",
          fontSize: 12, color: "#6b7280", lineHeight: 1.6,
        }}
      >
        <p style={{ margin: "0 0 4px" }}>💰 コスト目安：月あたり約 $3〜8 の追加（提案1回あたり約 $0.05〜0.10）</p>
        <p style={{ margin: 0 }}>※ 通常の提案機能は無料で引き続きご利用いただけます</p>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "#4b5563", textAlign: "right" }}>
        現在: <strong style={{ color: deepResearch ? "#60a5fa" : "#6b7280" }}>{deepResearch ? "ON" : "OFF"}</strong>
      </p>
    </div>
  );
}

// ─── コンバージョンタイプ設定タブ ─────────────────────────────────────────────

function ConversionTypesTab({
  tenant,
  onUpdate,
}: {
  tenant: TenantDetail;
  onUpdate: (updated: TenantDetail) => void;
}) {
  const [types, setTypes] = useState<string[]>(tenant.conversion_types ?? ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"]);
  const [newType, setNewType] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ msg: string; ok: boolean } | null>(null);

  const showMsg = (msg: string, ok: boolean) => {
    setSaveMsg({ msg, ok });
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const addType = () => {
    const trimmed = newType.trim();
    if (!trimmed) return;
    if (trimmed.length > 50) { showMsg("50文字以内で入力してください", false); return; }
    if (types.includes(trimmed)) { showMsg("同じタイプがすでに存在します", false); return; }
    if (types.length >= 10) { showMsg("最大10件まで登録できます", false); return; }
    setTypes([...types, trimmed]);
    setNewType("");
  };

  const removeType = (t: string) => setTypes(types.filter((x) => x !== t));

  const handleSave = async () => {
    if (types.length === 0) { showMsg("少なくとも1件必要です", false); return; }
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ conversion_types: types }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as any;
      const json = "tenant" in raw ? raw.tenant : raw;
      onUpdate({
        ...json,
        status: json.is_active ? "active" : "inactive",
        allowed_origins: json.allowed_origins ?? [],
        billing_enabled: json.billing_enabled ?? false,
        billing_free_from: json.billing_free_from ?? null,
        billing_free_until: json.billing_free_until ?? null,
        features: json.features ?? { avatar: false, voice: false, rag: true },
        lemonslice_agent_id: json.lemonslice_agent_id ?? null,
        conversion_types: json.conversion_types ?? types,
      } as TenantDetail);
      showMsg("✅ コンバージョンタイプを保存しました", true);
    } catch {
      showMsg("保存に失敗しました", false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p style={{ fontSize: 14, color: "#9ca3af", marginBottom: 20 }}>
        お客様の行動結果のカテゴリを設定します。会話詳細ページでこのカテゴリを選んで成果を記録できます。
      </p>
      {saveMsg && (
        <div style={{ marginBottom: 16, padding: "10px 16px", borderRadius: 8, fontSize: 14, fontWeight: 600,
          background: saveMsg.ok ? "rgba(5,46,22,0.5)" : "rgba(127,29,29,0.4)",
          border: `1px solid ${saveMsg.ok ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
          color: saveMsg.ok ? "#86efac" : "#fca5a5",
        }}>
          {saveMsg.msg}
        </div>
      )}
      {/* タイプ一覧 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
        {types.map((t) => (
          <span key={t} style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 999, fontSize: 14,
            background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#93c5fd",
          }}>
            {t}
            <button
              onClick={() => removeType(t)}
              style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
              title="削除"
            >
              ×
            </button>
          </span>
        ))}
        {types.length === 0 && <span style={{ fontSize: 14, color: "#6b7280" }}>タイプが登録されていません</span>}
      </div>
      {/* 追加フォーム */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          type="text"
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addType(); } }}
          placeholder="新しいタイプを追加（例: 資料請求）"
          maxLength={50}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 8,
            border: "1px solid #374151", background: "rgba(255,255,255,0.05)",
            color: "#f9fafb", fontSize: 14,
          }}
        />
        <button
          onClick={addType}
          disabled={!newType.trim() || types.length >= 10}
          style={{
            padding: "0 18px", minHeight: 44, borderRadius: 8,
            border: "1px solid rgba(59,130,246,0.4)", background: "rgba(59,130,246,0.15)",
            color: "#93c5fd", fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          ＋ 追加
        </button>
      </div>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 20 }}>最大10件、各50文字以内。現在 {types.length}/10 件</p>
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          padding: "12px 24px", minHeight: 48, borderRadius: 10,
          border: "none", background: saving ? "#1f2937" : "#1d4ed8",
          color: saving ? "#6b7280" : "#fff", fontSize: 15, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "保存中..." : "保存"}
      </button>
    </div>
  );
}

// ─── GA4連携タブ ──────────────────────────────────────────────────────────────

type Ga4Status = "not_configured" | "pending" | "connected" | "error" | "timeout" | "permission_revoked";

interface Ga4StatusData {
  ga4_property_id: string | null;
  ga4_status: Ga4Status;
  ga4_connected_at: string | null;
  ga4_last_sync_at: string | null;
  ga4_error_message: string | null;
  tenant_contact_email: string | null;
  recent_tests: { test_type: string; success: boolean; error_message: string | null; tested_at: string }[];
}

// ─── PostHog Integration Tab ──────────────────────────────────────────────

interface PostHogStatus {
  configured: boolean;
  key_hint: string | null;
}

function PostHogIntegrationTab({ tenantId }: { tenantId: string }) {
  const [status, setStatus] = useState<PostHogStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; status: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/status`)
      .then((r) => r.json() as Promise<PostHogStatus>)
      .then((d) => setStatus(d))
      .catch(() => setStatus({ configured: false, key_hint: null }));
  }, [tenantId]);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_api_key: apiKey.trim() }),
      });
      if (!res.ok) throw new Error();
      showToast("PostHog Project API Key を保存しました");
      setApiKey("");
      const updated = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/status`).then((r) => r.json() as Promise<PostHogStatus>);
      setStatus(updated);
    } catch {
      showToast("保存に失敗しました", false);
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/verify`, { method: "POST" });
      const d = await res.json() as { ok: boolean; status: string };
      setVerifyResult(d);
    } catch {
      setVerifyResult({ ok: false, status: "error" });
    } finally {
      setVerifying(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/disconnect`, { method: "DELETE" });
      setStatus({ configured: false, key_hint: null });
      setShowDisconnectModal(false);
      showToast("PostHog連携を解除しました");
    } catch {
      showToast("解除に失敗しました", false);
    } finally {
      setDisconnecting(false);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: "#1e293b", borderRadius: 8, padding: "20px 24px", marginBottom: 16,
  };
  const labelStyle: React.CSSProperties = {
    display: "block", color: "#9ca3af", fontSize: 12, marginBottom: 6,
  };
  const inputStyle: React.CSSProperties = {
    width: "100%", background: "#0f172a", border: "1px solid #334155",
    borderRadius: 6, color: "#e2e8f0", fontSize: 14, padding: "8px 12px",
  };
  const btnStyle = (color: string): React.CSSProperties => ({
    background: color, color: "#fff", border: "none", borderRadius: 6,
    padding: "8px 18px", fontSize: 13, cursor: "pointer", marginRight: 8,
  });

  return (
    <div style={{ padding: "16px 0" }}>
      {toast && (
        <div style={{
          position: "fixed", top: 16, right: 16, zIndex: 9999,
          background: toast.ok ? "#166534" : "#7f1d1d",
          color: "#fff", padding: "10px 20px", borderRadius: 8,
        }}>
          {toast.msg}
        </div>
      )}

      {/* 概要 */}
      <div style={cardStyle}>
        <div style={{ color: "#e2e8f0", fontSize: 15, fontWeight: 600, marginBottom: 8 }}>PostHog 連携</div>
        <div style={{ color: "#9ca3af", fontSize: 13, lineHeight: 1.6 }}>
          PostHog のプロジェクト API キーを登録すると、このテナントのウィジェットから
          widget_opened / message_sent / llm_response_received / cv_macro イベントが自動送信されます。
          <br />
          LLM Analytics ($ai_generation) も自動収集されます。
        </div>
        {status && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              background: status.configured ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.2)",
              color: status.configured ? "#4ade80" : "#9ca3af",
              borderRadius: 12, padding: "2px 10px", fontSize: 12,
            }}>
              {status.configured ? "✓ 設定済み" : "未設定"}
            </span>
            {status.key_hint && (
              <span style={{ color: "#9ca3af", fontSize: 12, fontFamily: "monospace" }}>
                キー: {status.key_hint}
              </span>
            )}
          </div>
        )}
      </div>

      {/* API Key 設定 */}
      <div style={cardStyle}>
        <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          Project API Key 設定
        </div>
        <label style={labelStyle}>
          PostHog Project API Key（phc_ で始まるキー）
        </label>
        <input
          type="password"
          style={inputStyle}
          placeholder="phc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
          AES-256-GCM で暗号化してDBに保存されます。平文は保存されません。
        </div>
        <button
          style={{ ...btnStyle("#2563eb"), marginTop: 12, opacity: (!apiKey.trim() || saving) ? 0.5 : 1 }}
          onClick={handleSave}
          disabled={!apiKey.trim() || saving}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>

      {/* 接続確認 */}
      {status?.configured && (
        <div style={cardStyle}>
          <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            接続確認
          </div>
          <button style={btnStyle("#0891b2")} onClick={handleVerify} disabled={verifying}>
            {verifying ? "テスト中..." : "接続テスト実行"}
          </button>
          {verifyResult && (
            <div style={{
              marginTop: 12, padding: "10px 14px", borderRadius: 6,
              background: verifyResult.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              color: verifyResult.ok ? "#4ade80" : "#f87171", fontSize: 13,
            }}>
              {verifyResult.ok
                ? "✓ PostHog への接続を確認しました"
                : `✗ 接続エラー: ${verifyResult.status}`}
            </div>
          )}
        </div>
      )}

      {/* 連携解除 */}
      {status?.configured && (
        <div style={cardStyle}>
          <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            連携解除
          </div>
          <button style={btnStyle("#dc2626")} onClick={() => setShowDisconnectModal(true)}>
            PostHog 連携を解除する
          </button>
        </div>
      )}

      {/* 解除確認モーダル */}
      {showDisconnectModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
        }}>
          <div style={{ background: "#1e293b", borderRadius: 8, padding: 24, maxWidth: 400, width: "90%" }}>
            <div style={{ color: "#e2e8f0", fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              PostHog 連携を解除しますか？
            </div>
            <div style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>
              Project API Key が削除されます。ウィジェットからのイベント送信が停止します。
            </div>
            <button style={btnStyle("#dc2626")} onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting ? "解除中..." : "解除する"}
            </button>
            <button style={btnStyle("#374151")} onClick={() => setShowDisconnectModal(false)}>
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GA4 Integration Tab ──────────────────────────────────────────────────

function Ga4IntegrationTab({ tenantId }: { tenantId: string }) {
  const [statusData, setStatusData] = useState<Ga4StatusData | null>(null);
  const [serviceAccountEmail, setServiceAccountEmail] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; result: { status: string; errorMessage?: string } } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    void loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function loadData() {
    setLoading(true);
    try {
      const [statusRes, saRes] = await Promise.all([
        authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/ga4/status`),
        authFetch(`${API_BASE}/v1/admin/ga4/service-account-info`),
      ]);
      if (statusRes.ok) {
        const data = await statusRes.json() as Ga4StatusData;
        setStatusData(data);
        setPropertyId(data.ga4_property_id ?? "");
        setContactEmail(data.tenant_contact_email ?? "");
      }
      if (saRes.ok) {
        const sa = await saRes.json() as { configured: boolean; client_email: string | null };
        setServiceAccountEmail(sa.client_email);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    if (!propertyId.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/ga4/connect`, {
        method: "POST",
        body: JSON.stringify({ property_id: propertyId.trim(), contact_email: contactEmail || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast("✅ GA4の識別番号を保存しました");
      await loadData();
    } catch {
      showToast("❌ 保存に失敗しました。もう一度お試しください");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/ga4/test`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { ok: boolean; result: { status: string; errorMessage?: string } };
      setTestResult(data);
      if (data.ok) {
        showToast("✅ GA4への接続に成功しました！");
        await loadData();
      }
    } catch {
      showToast("❌ 接続テストに失敗しました");
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    setShowDisconnectConfirm(false);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/ga4/disconnect`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      showToast("GA4連携を解除しました");
      setTestResult(null);
      await loadData();
    } catch {
      showToast("❌ 解除に失敗しました");
    }
  }

  function copyEmail() {
    if (!serviceAccountEmail) return;
    navigator.clipboard.writeText(serviceAccountEmail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  }

  const currentStatus: Ga4Status = statusData?.ga4_status ?? "not_configured";
  const isConnected = currentStatus === "connected";
  const hasPropertyId = (statusData?.ga4_property_id ?? "").length > 0;

  const CARD: React.CSSProperties = {
    background: "rgba(15,23,42,0.7)",
    border: "1px solid #1f2937",
    borderRadius: 14,
    padding: "24px 28px",
    marginBottom: 20,
  };

  const BTN_PRIMARY: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 24px",
    minHeight: 48,
    borderRadius: 10,
    border: "none",
    background: "linear-gradient(135deg,#16a34a,#22c55e)",
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    transition: "opacity .15s",
  };

  const BTN_SECONDARY: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 20px",
    minHeight: 44,
    borderRadius: 10,
    border: "1px solid #374151",
    background: "transparent",
    color: "#9ca3af",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  };

  function StatusBadge({ status }: { status: Ga4Status }) {
    const map: Record<Ga4Status, { label: string; color: string; bg: string }> = {
      not_configured: { label: "未設定", color: "#9ca3af", bg: "rgba(156,163,175,0.1)" },
      pending: { label: "設定中", color: "#fbbf24", bg: "rgba(251,191,36,0.1)" },
      connected: { label: "✅ 連携中", color: "#4ade80", bg: "rgba(74,222,128,0.1)" },
      error: { label: "❌ エラー", color: "#f87171", bg: "rgba(248,113,113,0.1)" },
      timeout: { label: "⏱ タイムアウト", color: "#fb923c", bg: "rgba(251,146,60,0.1)" },
      permission_revoked: { label: "🔒 権限なし", color: "#a78bfa", bg: "rgba(167,139,250,0.1)" },
    };
    const s = map[status];
    return (
      <span style={{ padding: "4px 12px", borderRadius: 999, fontSize: 13, fontWeight: 700, color: s.color, background: s.bg, border: `1px solid ${s.color}33` }}>
        {s.label}
      </span>
    );
  }

  function ErrorGuide({ status, message }: { status: Ga4Status; message?: string | null }) {
    const guides: Partial<Record<Ga4Status, string>> = {
      error: message?.includes("permission") || message === "permission_denied"
        ? "サービスアカウントに閲覧権限がありません。手順をもう一度確認してください。"
        : message === "property_not_found"
        ? "GA4の識別番号が見つかりません。GA4管理画面でご確認ください。"
        : "エラーが発生しました。サポートにお問い合わせください。",
      timeout: "GA4への接続に時間がかかっています。しばらく待ってからもう一度お試しください。",
      permission_revoked: "閲覧権限が取り消されました。GA4管理画面でサービスアカウントに再度権限を付与してください。",
    };
    const guide = guides[status];
    if (!guide) return null;
    return (
      <div style={{ padding: "14px 18px", borderRadius: 10, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5", fontSize: 14, lineHeight: 1.7, marginTop: 12 }}>
        ⚠️ {guide}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
        ⏳ 読み込み中...
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 4 }}>
      {/* トースト */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", padding: "14px 24px", borderRadius: 12, background: "rgba(15,23,42,0.98)", border: "1px solid #22c55e", color: "#4ade80", fontSize: 15, fontWeight: 600, zIndex: 3000, whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}

      {/* 確認モーダル */}
      {showDisconnectConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#0f172a", border: "1px solid #374151", borderRadius: 16, padding: 32, maxWidth: 400, width: "90%", textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>⚠️</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>GA4連携を解除しますか？</div>
            <div style={{ color: "#9ca3af", fontSize: 14, marginBottom: 28 }}>設定した識別番号と連携情報が削除されます。</div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button style={{ ...BTN_SECONDARY }} onClick={() => setShowDisconnectConfirm(false)}>キャンセル</button>
              <button style={{ ...BTN_PRIMARY, background: "linear-gradient(135deg,#dc2626,#ef4444)" }} onClick={() => void handleDisconnect()}>解除する</button>
            </div>
          </div>
        </div>
      )}

      {/* ヘッダー: 現在のステータス */}
      <div style={{ ...CARD, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", margin: "0 0 8px" }}>📊 Google Analytics 4 連携</h2>
          <div style={{ color: "#9ca3af", fontSize: 14 }}>
            GA4のデータをR2Cに連携することで、成果（コンバージョン）の計測精度が上がります。
          </div>
        </div>
        <StatusBadge status={currentStatus} />
      </div>

      {/* ステップ1: サービスアカウント案内 */}
      <div style={CARD}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>
          ステップ 1 — R2Cのメールアドレスに閲覧権限を付与する
        </h3>
        <div style={{ color: "#9ca3af", fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
          GA4の管理画面で、以下のメールアドレスに <strong style={{ color: "#e5e7eb" }}>「閲覧者」</strong> 権限を付与してください。
        </div>
        {serviceAccountEmail ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200, padding: "12px 16px", borderRadius: 8, background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.2)", fontFamily: "monospace", fontSize: 14, color: "#4ade80", wordBreak: "break-all" }}>
              {serviceAccountEmail}
            </div>
            <button style={{ ...BTN_SECONDARY, minWidth: 80 }} onClick={copyEmail}>
              {copied ? "✅ コピー済み" : "📋 コピー"}
            </button>
          </div>
        ) : (
          <div style={{ padding: "12px 16px", borderRadius: 8, background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.2)", color: "#fbbf24", fontSize: 14 }}>
            ⚙️ サービスアカウントがまだ設定されていません。担当者にお問い合わせください。
          </div>
        )}
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", color: "#60a5fa", fontSize: 13, userSelect: "none" }}>
            📖 GA4での権限付与手順を見る
          </summary>
          <ol style={{ color: "#9ca3af", fontSize: 13, lineHeight: 2, marginTop: 10, paddingLeft: 20 }}>
            <li>GA4管理画面（analytics.google.com）にログイン</li>
            <li>左下の「管理」→「アカウントのアクセス管理」をクリック</li>
            <li>右上の「＋」ボタン →「ユーザーを追加」</li>
            <li>上記のメールアドレスを入力</li>
            <li>役割: 「閲覧者」を選択 → 「追加」</li>
          </ol>
        </details>
      </div>

      {/* ステップ2: Property ID入力 */}
      <div style={CARD}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>
          ステップ 2 — GA4の識別番号を入力する
        </h3>
        <div style={{ color: "#9ca3af", fontSize: 14, marginBottom: 16 }}>
          GA4管理画面の「プロパティ詳細」ページに表示されている数字（例: <code style={{ color: "#a5b4fc" }}>123456789</code>）を入力してください。
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label style={{ display: "block", fontSize: 13, color: "#9ca3af", marginBottom: 6 }}>GA4識別番号 (数字のみ)</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="例: 123456789"
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value.replace(/\D/g, ""))}
              style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid #374151", background: "#0f172a", color: "#f1f5f9", fontSize: 15, boxSizing: "border-box" }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label style={{ display: "block", fontSize: 13, color: "#9ca3af", marginBottom: 6 }}>連絡先メールアドレス (任意)</label>
            <input
              type="email"
              placeholder="例: partner@example.com"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid #374151", background: "#0f172a", color: "#f1f5f9", fontSize: 15, boxSizing: "border-box" }}
            />
          </div>
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            style={{ ...BTN_PRIMARY, opacity: saving || !propertyId.trim() ? 0.6 : 1 }}
            disabled={saving || !propertyId.trim()}
            onClick={() => void handleConnect()}
          >
            {saving ? "⏳ 保存中..." : "💾 識別番号を保存"}
          </button>
        </div>
      </div>

      {/* ステップ3: 接続テスト */}
      {hasPropertyId && (
        <div style={CARD}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>
            ステップ 3 — 接続テスト
          </h3>
          <div style={{ color: "#9ca3af", fontSize: 14, marginBottom: 16 }}>
            識別番号: <code style={{ color: "#a5b4fc", fontSize: 14 }}>{statusData?.ga4_property_id}</code>
          </div>
          <button
            style={{ ...BTN_PRIMARY, opacity: testing ? 0.6 : 1 }}
            disabled={testing}
            onClick={() => void handleTest()}
          >
            {testing ? "⏳ テスト中..." : "🔗 GA4に接続テスト"}
          </button>

          {/* テスト結果 */}
          {testResult && (
            <div style={{ marginTop: 16, padding: "16px 20px", borderRadius: 10, background: testResult.ok ? "rgba(74,222,128,0.06)" : "rgba(239,68,68,0.06)", border: `1px solid ${testResult.ok ? "rgba(74,222,128,0.3)" : "rgba(239,68,68,0.3)"}` }}>
              {testResult.ok ? (
                <div style={{ color: "#4ade80", fontWeight: 700, fontSize: 15 }}>
                  ✅ 接続に成功しました！GA4のデータが取得できます。
                </div>
              ) : (
                <>
                  <div style={{ color: "#f87171", fontWeight: 700, fontSize: 15 }}>❌ 接続に失敗しました</div>
                  <ErrorGuide status={testResult.result.status as Ga4Status} message={testResult.result.errorMessage} />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* 連携済みステータス詳細 */}
      {isConnected && (
        <div style={CARD}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: 0 }}>🔗 連携情報</h3>
            <button style={{ ...BTN_SECONDARY, color: "#f87171", borderColor: "#f8717133" }} onClick={() => setShowDisconnectConfirm(true)}>
              🔌 連携を解除
            </button>
          </div>
          <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
            {statusData?.ga4_connected_at && (
              <div style={{ fontSize: 13, color: "#9ca3af" }}>
                ✅ 接続日時: <span style={{ color: "#d1d5db" }}>{new Date(statusData.ga4_connected_at).toLocaleString("ja-JP")}</span>
              </div>
            )}
            {statusData?.ga4_last_sync_at && (
              <div style={{ fontSize: 13, color: "#9ca3af" }}>
                🔄 最終同期: <span style={{ color: "#d1d5db" }}>{new Date(statusData.ga4_last_sync_at).toLocaleString("ja-JP")}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* エラー時のガイド */}
      {(currentStatus === "error" || currentStatus === "timeout" || currentStatus === "permission_revoked") && (
        <div style={CARD}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 4px" }}>⚠️ 接続エラー</h3>
          <ErrorGuide status={currentStatus} message={statusData?.ga4_error_message} />
        </div>
      )}

      {/* テスト履歴 */}
      {(statusData?.recent_tests ?? []).length > 0 && (
        <div style={CARD}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#9ca3af", margin: "0 0 12px" }}>接続テスト履歴</h3>
          <div style={{ display: "grid", gap: 6 }}>
            {statusData!.recent_tests.map((t, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid #1f2937", fontSize: 13 }}>
                <span style={{ color: t.success ? "#4ade80" : "#f87171" }}>{t.success ? "✅" : "❌"} {t.success ? "成功" : (t.error_message ?? "失敗")}</span>
                <span style={{ color: "#6b7280" }}>{new Date(t.tested_at).toLocaleString("ja-JP")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── タブ: アナリティクスサマリー ──────────────────────────────────────────────

interface AnalyticsSummary {
  period: string;
  conversations: { total: number; avg_per_day: number };
  cv: {
    macro: { r2c_db: number; ga4: number; posthog: number; ranked_a: number; ranked_d: number };
    micro: { r2c_db: number; ga4: number; posthog: number };
  };
  llm_usage: { tokens: number; cost_jpy: number; generations: number } | null;
  alerts: { source_mismatch_count: number; ranked_d_count: number };
}

function AnalyticsSummaryTab({ tenantId }: { tenantId: string }) {
  const [period, setPeriod] = useState<"last_7d" | "last_30d" | "last_90d">("last_30d");
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/analytics-summary?period=${period}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData(await res.json() as AnalyticsSummary);
      } catch {
        setError("データ取得に失敗しました");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [tenantId, period]);

  const periodLabel: Record<string, string> = { last_7d: "7日間", last_30d: "30日間", last_90d: "90日間" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Period selector */}
      <div style={{ ...CARD_STYLE, display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 14, color: "#9ca3af", fontWeight: 600 }}>期間:</span>
        {(["last_7d", "last_30d", "last_90d"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            style={{
              padding: "8px 16px",
              minHeight: 36,
              borderRadius: 8,
              border: period === p ? "1px solid #4ade80" : "1px solid #374151",
              background: period === p ? "rgba(34,197,94,0.15)" : "rgba(0,0,0,0.3)",
              color: period === p ? "#4ade80" : "#9ca3af",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {periodLabel[p]}
          </button>
        ))}
      </div>

      {loading && <div style={{ color: "#6b7280", textAlign: "center", padding: 32 }}>読み込み中...</div>}
      {error && <div style={{ color: "#f87171", padding: 16 }}>{error}</div>}

      {data && !loading && (
        <>
          {/* Conversations */}
          <div style={{ ...CARD_STYLE }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>💬 会話数</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { label: "総会話数", value: data.conversations.total.toLocaleString() },
                { label: "1日平均", value: `${data.conversations.avg_per_day}件` },
              ].map(({ label, value }) => (
                <div key={label} style={{ padding: "16px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid #1f2937" }}>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#e5e7eb" }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* CV */}
          <div style={{ ...CARD_STYLE }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>🎯 コンバージョン</h3>
            <div style={{ display: "grid", gap: 10 }}>
              {[
                { label: "マクロCV (r2c_db)", value: data.cv.macro.r2c_db },
                { label: "マクロCV (GA4)", value: data.cv.macro.ga4 },
                { label: "マクロCV (PostHog)", value: data.cv.macro.posthog },
                { label: "マイクロCV (r2c_db)", value: data.cv.micro.r2c_db },
                { label: "マイクロCV (GA4)", value: data.cv.micro.ga4 },
                { label: "ランクA (3ソース確認済)", value: data.cv.macro.ranked_a },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid #1f2937", fontSize: 14 }}>
                  <span style={{ color: "#9ca3af" }}>{label}</span>
                  <span style={{ color: "#e5e7eb", fontWeight: 600 }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* LLM Usage */}
          {data.llm_usage && (
            <div style={{ ...CARD_STYLE }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>🤖 LLM使用量（今月）</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  { label: "総トークン", value: data.llm_usage.tokens.toLocaleString() },
                  { label: "推定コスト", value: `¥${data.llm_usage.cost_jpy.toLocaleString()}` },
                  { label: "生成回数", value: data.llm_usage.generations.toLocaleString() },
                ].map(({ label, value }) => (
                  <div key={label} style={{ padding: "14px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid #1f2937" }}>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Alerts */}
          {(data.alerts.source_mismatch_count > 0 || data.alerts.ranked_d_count > 0) && (
            <div style={{ ...CARD_STYLE, border: "1px solid rgba(239,68,68,0.4)", background: "rgba(127,29,29,0.15)" }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "#f87171", margin: "0 0 12px" }}>⚠️ アラート</h3>
              <div style={{ display: "grid", gap: 8 }}>
                {data.alerts.source_mismatch_count > 0 && (
                  <div style={{ fontSize: 14, color: "#fca5a5" }}>ソース不一致: {data.alerts.source_mismatch_count}件（同一イベントが複数ソースで記録）</div>
                )}
                {data.alerts.ranked_d_count > 0 && (
                  <div style={{ fontSize: 14, color: "#fca5a5" }}>ランクD（疑義あり）: {data.alerts.ranked_d_count}件</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── タブ: 請求情報 ───────────────────────────────────────────────────────────

function BillingInfoTab({ tenant }: { tenant: TenantDetail }) {
  return (
    <div style={{ ...CARD_STYLE, display: "flex", flexDirection: "column", gap: 16 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: 0 }}>💳 請求情報</h3>
      <div style={{ display: "grid", gap: 10 }}>
        {[
          { label: "プラン", value: tenant.plan.toUpperCase() },
          { label: "課金有効", value: tenant.billing_enabled ? "有効" : "無効" },
          { label: "無料期間（開始）", value: tenant.billing_free_from ? new Date(tenant.billing_free_from).toLocaleDateString("ja-JP") : "—" },
          { label: "無料期間（終了）", value: tenant.billing_free_until ? new Date(tenant.billing_free_until).toLocaleDateString("ja-JP") : "—" },
        ].map(({ label, value }) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid #1f2937", fontSize: 14 }}>
            <span style={{ color: "#9ca3af" }}>{label}</span>
            <span style={{ color: "#e5e7eb", fontWeight: 600 }}>{value}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
        詳細な請求設定はSuper Admin専用の設定タブから変更できます。
      </p>
    </div>
  );
}

// ─── タブ: 通知設定 ───────────────────────────────────────────────────────────

interface NotificationPref {
  notification_type: string;
  email_enabled: boolean;
  in_app_enabled: boolean;
  threshold: Record<string, unknown> | null;
}

const DEFAULT_NOTIFICATION_TYPES = [
  { type: "ga4_error", label: "GA4接続エラー" },
  { type: "cv_drop", label: "CV数急減" },
  { type: "llm_cost_spike", label: "LLMコスト急増" },
  { type: "weekly_report", label: "週次レポート" },
];

function NotificationPreferencesTab({ tenantId }: { tenantId: string }) {
  const [prefs, setPrefs] = useState<Record<string, NotificationPref>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    const load = async () => {
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/notification-preferences`);
        if (!res.ok) return;
        const json = await res.json() as { preferences: NotificationPref[] };
        const map: Record<string, NotificationPref> = {};
        for (const p of json.preferences) map[p.notification_type] = p;
        setPrefs(map);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [tenantId]);

  const handleToggle = async (type: string, field: "email_enabled" | "in_app_enabled") => {
    const current = prefs[type] ?? { notification_type: type, email_enabled: true, in_app_enabled: true, threshold: null };
    const updated = { ...current, [field]: !current[field] };
    setSaving(type);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/notification-preferences`, {
        method: "PUT",
        body: JSON.stringify({ notification_type: type, email_enabled: updated.email_enabled, in_app_enabled: updated.in_app_enabled }),
      });
      if (res.ok) {
        setPrefs((prev) => ({ ...prev, [type]: updated }));
        showToast("✅ 保存しました");
      }
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <div style={{ color: "#6b7280", textAlign: "center", padding: 32 }}>読み込み中...</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {toast && (
        <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(15,23,42,0.98)", border: "1px solid #22c55e", color: "#4ade80", fontSize: 14, fontWeight: 600 }}>
          {toast}
        </div>
      )}
      <div style={{ ...CARD_STYLE }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: "0 0 16px" }}>🔔 通知設定</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {DEFAULT_NOTIFICATION_TYPES.map(({ type, label }) => {
            const pref = prefs[type] ?? { notification_type: type, email_enabled: true, in_app_enabled: true, threshold: null };
            const isSavingThis = saving === type;
            return (
              <div key={type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid #1f2937" }}>
                <span style={{ fontSize: 14, color: "#d1d5db", fontWeight: 500 }}>{label}</span>
                <div style={{ display: "flex", gap: 12 }}>
                  {(["email_enabled", "in_app_enabled"] as const).map((field) => (
                    <button
                      key={field}
                      type="button"
                      disabled={isSavingThis}
                      onClick={() => void handleToggle(type, field)}
                      style={{
                        padding: "6px 14px",
                        minHeight: 32,
                        borderRadius: 6,
                        border: pref[field] ? "1px solid #4ade80" : "1px solid #374151",
                        background: pref[field] ? "rgba(34,197,94,0.15)" : "rgba(0,0,0,0.3)",
                        color: pref[field] ? "#4ade80" : "#6b7280",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: isSavingThis ? "not-allowed" : "pointer",
                        opacity: isSavingThis ? 0.5 : 1,
                      }}
                    >
                      {field === "email_enabled" ? "📧 メール" : "🔔 アプリ内"}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
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
