import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { API_BASE, authFetch } from "../../../lib/api";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { useAuth } from "../../../auth/useAuth";

interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "pro";
  status: "active" | "inactive";
  faqCount?: number;
}

export default function KnowledgeIndexPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { user, isSuperAdmin, isClientAdmin, isLoading } = useAuth();

  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!isSuperAdmin) return;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/tenants`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { tenants?: TenantSummary[]; items?: TenantSummary[] };
        setTenants(data.tenants ?? data.items ?? []);
      } catch (err) {
        if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
          navigate("/login", { replace: true });
          return;
        }
        setError(t("tenants.load_error"));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [isSuperAdmin, navigate, t]);

  const filtered = tenants.filter((ten) =>
    ten.name.toLowerCase().includes(search.toLowerCase()) ||
    ten.slug.toLowerCase().includes(search.toLowerCase())
  );

  // Client Admin → 自テナントに直接リダイレクト（hooks の後）
  if (!isLoading && isClientAdmin && !isSuperAdmin && user?.tenantId) {
    return <Navigate to={`/admin/knowledge/${user.tenantId}`} replace />;
  }

  if (isLoading) return null;

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
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "8px 14px", minHeight: 44, borderRadius: 999, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 14, cursor: "pointer", fontWeight: 500 }}
          >
            {t("nav.back_dashboard")}
          </button>
          <LangSwitcher />
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
          {t("knowledge.title")}
        </h1>
        <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
          {t("knowledge.select_tenant")}
        </p>
      </header>

      {/* グローバルナレッジカード */}
      <button
        onClick={() => navigate("/admin/knowledge/global")}
        style={{
          width: "100%",
          padding: "20px 24px",
          minHeight: 72,
          borderRadius: 14,
          border: "1px solid rgba(234,179,8,0.3)",
          background: "rgba(234,179,8,0.06)",
          color: "#fbbf24",
          fontSize: 16,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 20,
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 28, flexShrink: 0 }}>📚</span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fbbf24" }}>
            {t("knowledge.global")}
          </div>
          <div style={{ fontSize: 13, color: "#92400e", fontWeight: 400, marginTop: 2 }}>
            {t("knowledge.global_desc")}
          </div>
        </div>
        <span style={{ marginLeft: "auto", fontSize: 20, color: "#fbbf24", opacity: 0.5 }}>›</span>
      </button>

      {/* 検索バー */}
      <div style={{ position: "relative", marginBottom: 16 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("knowledge.search_tenant")}
          style={{
            width: "100%",
            padding: "14px 44px 14px 16px",
            borderRadius: 12,
            border: "1px solid #374151",
            background: "rgba(15,23,42,0.8)",
            color: "#e5e7eb",
            fontSize: 16,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "#6b7280", fontSize: 18 }}>
          🔍
        </span>
      </div>

      {/* エラー */}
      {error && (
        <div style={{ marginBottom: 16, padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {/* テナントリスト */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          {t("common.loading")}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", borderRadius: 14, border: "1px dashed #374151", background: "rgba(15,23,42,0.4)", color: "#6b7280", fontSize: 15 }}>
          {search ? `「${search}」に一致するテナントが見つかりません` : t("tenants.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((tenant) => (
            <button
              key={tenant.id}
              onClick={() => navigate(`/admin/knowledge/${tenant.id}`)}
              style={{
                width: "100%",
                padding: "16px 20px",
                minHeight: 64,
                borderRadius: 14,
                border: "1px solid #1f2937",
                background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                color: "#e5e7eb",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 14,
                textAlign: "left",
              }}
            >
              <span style={{ fontSize: 24, flexShrink: 0 }}>🏢</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#f9fafb", marginBottom: 2 }}>
                  {tenant.name}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "monospace" }}>
                  {tenant.slug}
                  {tenant.status === "inactive" && (
                    <span style={{ marginLeft: 8, color: "#9ca3af", fontFamily: "inherit" }}>
                      ({t("tenants.status_inactive")})
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
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
                <span style={{ fontSize: 20, color: "#6b7280" }}>›</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
