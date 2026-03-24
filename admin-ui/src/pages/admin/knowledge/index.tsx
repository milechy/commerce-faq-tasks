import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { useAuth } from "../../../auth/useAuth";
import { API_BASE } from "../../../lib/api";
import { fetchWithAuth } from "../../../components/knowledge/shared";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "pro";
  status: "active" | "inactive";
}

export default function KnowledgePage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { user, isSuperAdmin, isLoading } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // client_admin → 自テナントにリダイレクト
  useEffect(() => {
    if (isLoading) return;
    if (!isSuperAdmin && user?.tenantId) {
      navigate(`/admin/knowledge/${user.tenantId}`, { replace: true });
    }
  }, [isLoading, isSuperAdmin, user, navigate]);

  // super_admin → テナント一覧を取得
  useEffect(() => {
    if (!isSuperAdmin) return;
    setLoadingTenants(true);
    fetchWithAuth(`${API_BASE}/v1/admin/tenants`)
      .then((res) => res.json() as Promise<{ tenants?: Tenant[]; items?: Tenant[] }>)
      .then((data) => setTenants(data.tenants ?? data.items ?? []))
      .catch(() => setError(t("knowledge.load_error")))
      .finally(() => setLoadingTenants(false));
  }, [isSuperAdmin, t]);

  // リダイレクト中は何も表示しない
  if (isLoading || (!isSuperAdmin && user?.tenantId)) {
    return null;
  }

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
      <header style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
          <button
            onClick={() => navigate("/admin")}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 0", border: "none", background: "none", color: "#9ca3af", fontSize: 13, cursor: "pointer" }}
          >
            {t("common.back_to_dashboard")}
          </button>
          <LangSwitcher />
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
          {t("knowledge.title")}
        </h1>
        <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
          {t("knowledge.subtitle")}
        </p>
      </header>

      {/* グローバルナレッジカード（super_admin のみ） */}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch", marginBottom: 12 }}>
        <button
          onClick={() => navigate("/admin/knowledge/global")}
          style={{
            flex: 1,
            padding: "20px 18px",
            borderRadius: 14,
            border: "1px solid rgba(234,179,8,0.3)",
            background: "linear-gradient(145deg, rgba(120,53,15,0.3), rgba(15,23,42,0.7))",
            color: "#fbbf24",
            fontSize: 16,
            fontWeight: 700,
            cursor: "pointer",
            textAlign: "left",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 24 }}>🌐</span>
          <div>
            <div>グローバルナレッジ</div>
            <div style={{ fontSize: 13, fontWeight: 400, color: "#d97706", marginTop: 2 }}>
              全テナント共通のナレッジを管理
            </div>
          </div>
          <span style={{ marginLeft: "auto", fontSize: 18, color: "#d97706" }}>›</span>
        </button>
        <button
          onClick={() => navigate("/admin/chat-test?scope=global")}
          style={{
            padding: "12px 16px",
            minHeight: 44,
            borderRadius: 14,
            border: "1px solid rgba(59,130,246,0.3)",
            background: "rgba(59,130,246,0.08)",
            color: "#93c5fd",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title="グローバルナレッジのテストチャットを開く"
        >
          💬 テスト
        </button>
      </div>

      {/* テナント一覧 */}
      {error && (
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loadingTenants ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          {t("knowledge.loading")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tenants.map((tenant) => (
            <div key={tenant.id} style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <button
                onClick={() => navigate(`/admin/knowledge/${tenant.id}`)}
                style={{
                  flex: 1,
                  padding: "18px 20px",
                  borderRadius: 14,
                  border: "1px solid #1f2937",
                  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                  color: "#e5e7eb",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  transition: "border-color 0.15s",
                }}
              >
                <span style={{ fontSize: 22 }}>🏢</span>
                <div style={{ flex: 1 }}>
                  <div style={{ color: "#f9fafb" }}>{tenant.name}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                    {tenant.slug} · {tenant.plan === "pro" ? "プロ" : "スターター"} · {tenant.status === "active" ? "✅ 有効" : "⏸ 停止中"}
                  </div>
                </div>
                <span style={{ fontSize: 18, color: "#6b7280" }}>›</span>
              </button>
              <button
                onClick={() => navigate(`/admin/chat-test?tenantId=${encodeURIComponent(tenant.id)}`)}
                style={{
                  padding: "12px 16px",
                  minHeight: 44,
                  borderRadius: 14,
                  border: "1px solid rgba(59,130,246,0.3)",
                  background: "rgba(59,130,246,0.08)",
                  color: "#93c5fd",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
                title={`${tenant.name} のテストチャットを開く`}
              >
                💬 テスト
              </button>
            </div>
          ))}
          {tenants.length === 0 && !loadingTenants && (
            <div style={{ padding: 40, textAlign: "center", borderRadius: 14, border: "1px dashed #374151", background: "rgba(15,23,42,0.4)" }}>
              <span style={{ display: "block", fontSize: 40, marginBottom: 12 }}>📭</span>
              <p style={{ fontSize: 16, fontWeight: 600, color: "#d1d5db", margin: 0 }}>
                {t("knowledge.empty_title")}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
