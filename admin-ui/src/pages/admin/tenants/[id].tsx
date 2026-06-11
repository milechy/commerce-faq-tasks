import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
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
import { AvatarTab } from "./AvatarTab";
import { SettingsTab } from "./SettingsTab";
import { TenantDetailHeader } from "./TenantDetailHeader";
import type { TenantFeatures, TenantDetail, ApiKey, TabId } from "./types";

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

// ─── スタイル定数 (CARD_STYLE, INPUT_STYLE, LABEL_STYLE は ./types に移動) ───

// ─── メインページ (TabId は ./types に移動) ──────────────────────────────────

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
        background: "var(--background)",
        color: "var(--foreground)",
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
            background: "var(--card)",
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
      <TenantDetailHeader
        loading={loading}
        tenant={tenant}
        navigate={navigate}
        handleEnterPreview={handleEnterPreview}
        t={t}
      />

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 120,
            color: "var(--muted-foreground)",
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
              background: "var(--card)",
              border: "1px solid var(--border)",
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
              updateBilling={updateBilling}
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
              updateAvatarSettings={updateAvatarSettings}
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
            border: "1px solid var(--border)",
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
