import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "pro";
  status: "active" | "inactive";
  apiKeyCount: number;
  createdAt: string;
}

// ─── モックデータ ─────────────────────────────────────────────────────────────

const MOCK_TENANTS: Tenant[] = [
  { id: "1", name: "カーネーション自動車", slug: "carnation", plan: "pro", status: "active", apiKeyCount: 2, createdAt: "2024-01-15T00:00:00Z" },
  { id: "2", name: "サクラ不動産", slug: "sakura-realty", plan: "starter", status: "active", apiKeyCount: 1, createdAt: "2024-02-20T00:00:00Z" },
  { id: "3", name: "テスト株式会社", slug: "test-corp", plan: "starter", status: "inactive", apiKeyCount: 0, createdAt: "2024-03-01T00:00:00Z" },
];

// ─── API関数 ─────────────────────────────────────────────────────────────────

async function fetchTenants(): Promise<Tenant[]> {
  return MOCK_TENANTS;
}

async function createTenant(data: { name: string; slug: string; plan: string }): Promise<Tenant> {
  const newTenant: Tenant = {
    id: String(Date.now()),
    name: data.name,
    slug: data.slug,
    plan: data.plan as "starter" | "pro",
    status: "active",
    apiKeyCount: 0,
    createdAt: new Date().toISOString(),
  };
  return newTenant;
}

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
};

// ─── テナント作成モーダル ──────────────────────────────────────────────────────

interface CreateModalProps {
  onClose: () => void;
  onSuccess: (tenant: Tenant) => void;
}

function CreateTenantModal({ onClose, onSuccess }: CreateModalProps) {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [plan, setPlan] = useState<"starter" | "pro">("starter");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugValid = /^[a-z0-9-]+$/.test(slug);
  const canSubmit = name.trim().length > 0 && slug.length > 0 && slugValid && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const tenant = await createTenant({ name: name.trim(), slug, plan });
      onSuccess(tenant);
    } catch {
      setError(t("tenants.create_error"));
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const inputStyle: React.CSSProperties = {
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

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    color: "#9ca3af",
    marginBottom: 6,
  };

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #1f2937",
          borderRadius: 16,
          padding: "28px 24px",
          maxWidth: 480,
          width: "100%",
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb", margin: "0 0 24px" }}>
          {t("tenants.modal_title")}
        </h2>

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

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>{t("tenants.name_label")}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("tenants.name_placeholder")}
              style={inputStyle}
              required
            />
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>{t("tenants.slug_label")}</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder={t("tenants.slug_placeholder")}
              style={{
                ...inputStyle,
                borderColor: slug && !slugValid ? "#ef4444" : "#374151",
              }}
              required
            />
            {slug && !slugValid && (
              <p style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>
                {t("tenants.slug_invalid")}
              </p>
            )}
          </div>

          <div style={{ marginBottom: 28 }}>
            <label style={labelStyle}>{t("tenants.plan_label")}</label>
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

          <div style={{ display: "flex", gap: 12, flexDirection: "column" }}>
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                padding: "16px 24px",
                minHeight: 56,
                borderRadius: 12,
                border: "none",
                background: canSubmit
                  ? "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)"
                  : "rgba(34,197,94,0.3)",
                color: "#022c22",
                fontSize: 17,
                fontWeight: 700,
                cursor: canSubmit ? "pointer" : "not-allowed",
                width: "100%",
              }}
            >
              {loading ? t("tenants.creating") : t("tenants.create")}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              style={{
                padding: "14px 24px",
                minHeight: 48,
                borderRadius: 12,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                width: "100%",
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

export default function TenantsPage() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const locale = lang === "en" ? "en-US" : "ja-JP";
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await fetchTenants();
        setTenants(data);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleCreateSuccess = (newTenant: Tenant) => {
    setTenants((prev) => [...prev, newTenant]);
    setShowModal(false);
    showToast(t("tenants.created_success"));
  };

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
            onClick={() => navigate("/admin")}
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
            {t("common.back_to_dashboard")}
          </button>
          <LangSwitcher />
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: "0 0 4px", color: "#f9fafb" }}>
          {t("tenants.title")}
        </h1>
        <p style={{ fontSize: 14, color: "#9ca3af", margin: 0 }}>
          {t("tenants.subtitle")}
        </p>
      </header>

      {/* 追加ボタン */}
      <button
        onClick={() => setShowModal(true)}
        style={{
          width: "100%",
          padding: "18px 24px",
          minHeight: 60,
          borderRadius: 14,
          border: "none",
          background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: "#022c22",
          fontSize: 17,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          boxShadow: "0 8px 25px rgba(34,197,94,0.25)",
          marginBottom: 24,
        }}
      >
        <span style={{ fontSize: 22 }}>＋</span>
        {t("tenants.add")}
      </button>

      {/* テナント一覧 */}
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
          {t("tenants.loading")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tenants.length === 0 ? (
            <div
              style={{
                ...CARD_STYLE,
                textAlign: "center",
                color: "#6b7280",
                fontSize: 15,
                padding: "40px 20px",
              }}
            >
              {t("tenants.empty")}
            </div>
          ) : (
            tenants.map((tenant) => (
              <div
                key={tenant.id}
                style={{
                  ...CARD_STYLE,
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                }}
              >
                {/* テナント情報 */}
                <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb" }}>
                      {tenant.name}
                    </span>
                    {/* 状態バッジ */}
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        background: tenant.status === "active" ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.2)",
                        color: tenant.status === "active" ? "#4ade80" : "#9ca3af",
                        border: `1px solid ${tenant.status === "active" ? "rgba(74,222,128,0.3)" : "rgba(107,114,128,0.3)"}`,
                      }}
                    >
                      {tenant.status === "active" ? t("tenants.status_active") : t("tenants.status_inactive")}
                    </span>
                    {/* プランバッジ */}
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 700,
                        background: tenant.plan === "pro" ? "rgba(59,130,246,0.15)" : "rgba(107,114,128,0.2)",
                        color: tenant.plan === "pro" ? "#60a5fa" : "#9ca3af",
                        border: `1px solid ${tenant.plan === "pro" ? "rgba(96,165,250,0.3)" : "rgba(107,114,128,0.3)"}`,
                      }}
                    >
                      {tenant.plan === "pro" ? "Pro" : "Starter"}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280" }}>
                    slug: <span style={{ fontFamily: "monospace", color: "#9ca3af" }}>{tenant.slug}</span>
                  </div>
                </div>

                {/* メタ情報 */}
                <div
                  style={{
                    display: "flex",
                    gap: 20,
                    flexWrap: "wrap",
                    fontSize: 13,
                    color: "#9ca3af",
                  }}
                >
                  <div>
                    <span style={{ color: "#6b7280" }}>{t("tenants.api_keys", { n: tenant.apiKeyCount })}</span>
                  </div>
                  <div>
                    <span style={{ color: "#6b7280" }}>
                      {t("tenants.created_at", { date: new Date(tenant.createdAt).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) })}
                    </span>
                  </div>
                </div>

                {/* 設定ボタン */}
                <button
                  onClick={() => navigate(`/admin/tenants/${tenant.id}`)}
                  style={{
                    padding: "10px 18px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid #374151",
                    background: "rgba(0,0,0,0.3)",
                    color: "#d1d5db",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("tenants.settings")}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* 作成モーダル */}
      {showModal && (
        <CreateTenantModal
          onClose={() => setShowModal(false)}
          onSuccess={handleCreateSuccess}
        />
      )}
    </div>
  );
}
