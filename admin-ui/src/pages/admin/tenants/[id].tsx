import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import ApiKeyCreateModal from "../../../components/ApiKeyCreateModal";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { API_BASE } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";
import { useAuth } from "../../../auth/useAuth";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

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
  } as TenantDetail;
}

async function updateTenant(
  tenantId: string,
  data: { name: string; plan: "starter" | "pro"; status: "active" | "inactive"; allowed_origins: string[] }
): Promise<TenantDetail> {
  // Backend expects is_active: boolean (not status string)
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: data.name,
      plan: data.plan,
      is_active: data.status === "active",
      allowed_origins: data.allowed_origins,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await res.json()) as any;
  const json = "tenant" in raw ? raw.tenant : raw;
  return { ...json, status: json.is_active ? "active" : "inactive", allowed_origins: json.allowed_origins ?? [] } as TenantDetail;
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

// ─── タブ: 設定 ───────────────────────────────────────────────────────────────

function SettingsTab({
  tenant,
  onSave,
}: {
  tenant: TenantDetail;
  onSave: (data: { name: string; plan: "starter" | "pro"; status: "active" | "inactive"; allowed_origins: string[] }) => Promise<void>;
}) {
  const { t } = useLang();
  const [name, setName] = useState(tenant.name);
  const [plan, setPlan] = useState<"starter" | "pro">(tenant.plan);
  const [status, setStatus] = useState<"active" | "inactive">(tenant.status);
  const [originsText, setOriginsText] = useState((tenant.allowed_origins ?? []).join("\n"));
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
      await onSave({ name: name.trim(), plan, status, allowed_origins });
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
          <label style={LABEL_STYLE}>{t("tenant_detail.settings_plan_label")}</label>
          <div style={{ display: "flex", gap: 12 }}>
            {(["starter", "pro"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlan(p)}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: plan === p ? "1px solid #4ade80" : "1px solid #374151",
                  background: plan === p ? "rgba(34,197,94,0.15)" : "rgba(0,0,0,0.3)",
                  color: plan === p ? "#4ade80" : "#9ca3af",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {p === "starter" ? "Starter" : "Pro"}
              </button>
            ))}
          </div>
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
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontSize: 14,
                      color: "#86efac",
                      wordBreak: "break-all",
                    }}
                  >
                    {key.maskedKey}
                  </span>
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

  const activeKey = apiKeys.find((k) => k.status === "active");
  const displayKey = activeKey ? activeKey.maskedKey : "YOUR_API_KEY";

  const embedCode = `<script src="https://cdn.rajiuce.com/widget.js"
  data-api-key="${displayKey}"
  data-tenant="${tenant.slug}"
  data-title="${tenant.widgetTitle}"
  data-color="${tenant.widgetColor}">
</script>`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API not available
    }
  };

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
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

type TabId = "settings" | "apikeys" | "embed";

export default function TenantDetailPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { id } = useParams<{ id: string }>();
  const tenantId = id ?? "1";
  const { enterPreview } = useAuth();

  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("settings");
  const [toast, setToast] = useState<string | null>(null);

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
    plan: "starter" | "pro";
    status: "active" | "inactive";
    allowed_origins: string[];
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

  const TABS: { id: TabId; label: string }[] = [
    { id: "settings", label: t("tenant_detail.tab_settings") },
    { id: "apikeys", label: t("tenant_detail.tab_apikeys") },
    { id: "embed", label: t("tenant_detail.tab_embed") },
  ];

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
        {tenant && (
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
              display: "flex",
              gap: 4,
              marginBottom: 24,
              background: "rgba(15,23,42,0.8)",
              border: "1px solid #1f2937",
              borderRadius: 12,
              padding: 4,
            }}
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  minHeight: 44,
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

          {/* タブコンテンツ */}
          {activeTab === "settings" && (
            <SettingsTab tenant={tenant} onSave={handleSaveSettings} />
          )}
          {activeTab === "apikeys" && (
            <ApiKeysTab tenantId={tenantId} />
          )}
          {activeTab === "embed" && (
            <EmbedCodeTab tenant={tenant} apiKeys={apiKeys} />
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
