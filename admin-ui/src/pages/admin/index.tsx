import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, getTenantIdFromSession } from "../../lib/api";
import { useLang } from "../../i18n/LangContext";
import LangSwitcher from "../../components/LangSwitcher";
import { useAuth } from "../../auth/useAuth";
import { SuperAdminOnly } from "../../components/RoleGuard";

interface DashboardStats {
  faqCount: number;
  bookCount: number;
  publishedFaqCount: number;
  lastUpdated: string | null;
}

function getAccessToken(): string | null {
  const raw = localStorage.getItem("supabaseSession");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { access_token?: string })?.access_token ?? null;
  } catch {
    localStorage.removeItem("supabaseSession");
    return null;
  }
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: string;
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        flex: "1 1 140px",
        borderRadius: 14,
        border: "1px solid #1f2937",
        background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
        padding: "20px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
      }}
    >
      <span style={{ fontSize: 28 }}>{icon}</span>
      <span
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: accent ?? "#f9fafb",
          lineHeight: 1,
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>{label}</span>
      {sub && <span style={{ fontSize: 12, color: "#6b7280" }}>{sub}</span>}
    </div>
  );
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const { user, isSuperAdmin, isClientAdmin, logout, previewMode, previewTenantName, exitPreview } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      navigate("/login", { replace: true });
      return;
    }

    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);

        const effectiveTenantId = previewMode
          ? (previewTenantId ?? "")
          : (user?.tenantId ?? getTenantIdFromSession() ?? "");

        const faqParams = new URLSearchParams({ limit: "1", offset: "0" });
        if (effectiveTenantId) faqParams.set("tenantId", effectiveTenantId);

        const knowledgeUrl = effectiveTenantId
          ? `${API_BASE}/v1/admin/knowledge?tenant=${effectiveTenantId}`
          : `${API_BASE}/v1/admin/knowledge`;

        const [faqRes, bookRes] = await Promise.allSettled([
          fetch(`${API_BASE}/admin/faqs?${faqParams.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(knowledgeUrl, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);

        let faqCount = 0;
        let publishedFaqCount = 0;
        let bookCount = 0;
        let lastUpdated: string | null = null;

        if (faqRes.status === "fulfilled" && faqRes.value.ok) {
          const data = (await faqRes.value.json()) as {
            pagination?: { count?: number };
            items?: Array<{ is_published: boolean; updated_at: string }>;
          };
          faqCount = data.pagination?.count ?? 0;
          if (data.items) {
            publishedFaqCount = data.items.filter((f) => f.is_published).length;
            const latest = data.items
              .map((f) => f.updated_at)
              .sort()
              .reverse()[0];
            if (latest) lastUpdated = latest;
          }
        }

        if (bookRes.status === "fulfilled" && bookRes.value.ok) {
          const data = (await bookRes.value.json()) as { books?: unknown[] };
          bookCount = data.books?.length ?? 0;
        }

        setStats({ faqCount, publishedFaqCount, bookCount, lastUpdated });
      } catch {
        setError(t("dashboard.error"));
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [navigate, t]);

  const handleLogout = async () => {
    localStorage.removeItem("supabaseSession");
    await logout();
    navigate("/login", { replace: true });
  };

  const locale = lang === "en" ? "en-US" : "ja-JP";

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      {previewMode && <div style={{ height: 44 }} />}
      {/* プレビューモードバナー */}
      {previewMode && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "rgba(234,179,8,0.95)",
            padding: "10px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            fontSize: 14,
            fontWeight: 600,
            color: "#1c1917",
            boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          }}
        >
          <span>👁 {t("preview.mode_label")}</span>
          <span style={{ color: "#78350f" }}>
            {t("preview.viewing_as", { tenant: previewTenantName ?? "" })}
          </span>
          <button
            onClick={exitPreview}
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              border: "1px solid #78350f",
              background: "rgba(0,0,0,0.15)",
              color: "#1c1917",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {t("preview.exit")}
          </button>
        </div>
      )}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 32,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: 999,
              background: "rgba(15,23,42,0.9)",
              border: "1px solid #1f2937",
              fontSize: 12,
              color: "#9ca3af",
              marginBottom: 8,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#22c55e",
                boxShadow: "0 0 6px #22c55e",
              }}
            />
            {t("dashboard.connected")}
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            {t("dashboard.title")}
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            {t("dashboard.subtitle")}
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {user && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: isSuperAdmin ? "rgba(234,179,8,0.15)" : "rgba(59,130,246,0.15)",
                  border: `1px solid ${isSuperAdmin ? "rgba(234,179,8,0.4)" : "rgba(59,130,246,0.4)"}`,
                  color: isSuperAdmin ? "#fbbf24" : "#60a5fa",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {isSuperAdmin ? t("role.super_admin") : isClientAdmin ? (user.tenantName ?? t("role.client_admin")) : t("role.anonymous")}
              </span>
              <span style={{ fontSize: 13, color: "#6b7280", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user.email}
              </span>
            </div>
          )}
          <LangSwitcher />
          <button
            onClick={() => void handleLogout()}
            style={{
              padding: "10px 16px",
              minHeight: 44,
              borderRadius: 999,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
              fontSize: 14,
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            {t("dashboard.logout")}
          </button>
        </div>
      </header>

      {error && (
        <div
          style={{
            marginBottom: 24,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 15,
          }}
        >
          {error}
        </div>
      )}

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
          {t("dashboard.loading")}
        </div>
      ) : (
        <>
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>
              {t("dashboard.current_status")}
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <StatCard
                icon="💬"
                label={t("dashboard.faq_count")}
                value={stats?.faqCount ?? 0}
                sub={t("dashboard.faq_count_sub")}
              />
              <StatCard
                icon="✅"
                label={t("dashboard.published_faq")}
                value={stats?.publishedFaqCount ?? 0}
                accent="#4ade80"
                sub={t("dashboard.published_faq_sub")}
              />
              <StatCard
                icon="📚"
                label={t("dashboard.knowledge_count")}
                value={stats?.bookCount ?? 0}
                sub={t("dashboard.knowledge_count_sub")}
              />
              <StatCard
                icon="🕐"
                label={t("dashboard.last_updated")}
                value={
                  stats?.lastUpdated
                    ? new Date(stats.lastUpdated).toLocaleDateString(locale, {
                        month: "short",
                        day: "numeric",
                      })
                    : "—"
                }
                sub={stats?.lastUpdated ? t("dashboard.last_updated_sub") : t("dashboard.no_updates")}
              />
            </div>
          </section>

          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>
              {t("dashboard.quick_actions")}
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <button
                onClick={() => navigate("/faqs")}
                style={{
                  flex: "1 1 200px",
                  padding: "18px 20px",
                  minHeight: 56,
                  borderRadius: 12,
                  border: "1px solid #1f2937",
                  background: "rgba(15,23,42,0.8)",
                  color: "#e5e7eb",
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#4b5563";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#1f2937";
                }}
              >
                <span style={{ fontSize: 22 }}>💬</span>
                {t("dashboard.manage_faq")}
              </button>

              <button
                onClick={() => navigate("/admin/knowledge")}
                style={{
                  flex: "1 1 200px",
                  padding: "18px 20px",
                  minHeight: 56,
                  borderRadius: 12,
                  border: "1px solid #1f2937",
                  background: "rgba(15,23,42,0.8)",
                  color: "#e5e7eb",
                  fontSize: 16,
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#4b5563";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#1f2937";
                }}
              >
                <span style={{ fontSize: 22 }}>📚</span>
                {t("dashboard.manage_knowledge")}
              </button>

              <button
                onClick={() => navigate("/faqs/new")}
                style={{
                  flex: "1 1 200px",
                  padding: "18px 20px",
                  minHeight: 56,
                  borderRadius: 12,
                  border: "none",
                  background:
                    "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
                  color: "#022c22",
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  boxShadow: "0 8px 25px rgba(34,197,94,0.25)",
                  transition: "box-shadow 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.boxShadow =
                    "0 10px 30px rgba(34,197,94,0.4)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.boxShadow =
                    "0 8px 25px rgba(34,197,94,0.25)";
                }}
              >
                <span style={{ fontSize: 22 }}>＋</span>
                {t("dashboard.add_faq")}
              </button>

              <SuperAdminOnly>
                <button
                  onClick={() => navigate("/admin/tenants")}
                  style={{
                    flex: "1 1 200px",
                    padding: "18px 20px",
                    minHeight: 56,
                    borderRadius: 12,
                    border: "1px solid #1f2937",
                    background: "rgba(15,23,42,0.8)",
                    color: "#e5e7eb",
                    fontSize: 16,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    transition: "border-color 0.15s",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#4b5563"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#1f2937"; }}
                >
                  <span style={{ fontSize: 22 }}>🏢</span>
                  {t("dashboard.manage_tenants")}
                </button>
              </SuperAdminOnly>

              <SuperAdminOnly>
                <button
                  onClick={() => navigate("/admin/billing")}
                  style={{
                    flex: "1 1 200px",
                    padding: "18px 20px",
                    minHeight: 56,
                    borderRadius: 12,
                    border: "1px solid #1f2937",
                    background: "rgba(15,23,42,0.8)",
                    color: "#e5e7eb",
                    fontSize: 16,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    transition: "border-color 0.15s",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#4b5563"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#1f2937"; }}
                >
                  <span style={{ fontSize: 22 }}>💰</span>
                  {t("dashboard.view_billing")}
                </button>
              </SuperAdminOnly>

              {isClientAdmin && (
                <button
                  onClick={() => navigate("/admin/chat-test")}
                  style={{
                    flex: "1 1 200px",
                    padding: "18px 20px",
                    minHeight: 56,
                    borderRadius: 12,
                    border: "none",
                    background: "linear-gradient(135deg, #3b82f6 0%, #60a5fa 50%, #3b82f6 100%)",
                    color: "#fff",
                    fontSize: 16,
                    fontWeight: 700,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    boxShadow: "0 8px 25px rgba(59,130,246,0.3)",
                    transition: "box-shadow 0.15s",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 10px 30px rgba(59,130,246,0.5)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 8px 25px rgba(59,130,246,0.3)"; }}
                >
                  <span style={{ fontSize: 22 }}>💬</span>
                  {t("chat_test.button")}
                </button>
              )}
            </div>
          </section>

        </>
      )}
    </div>
  );
}
