// admin-ui/src/pages/admin/index.tsx
// Phase B-2: Dashboard restructure — lean KPI view (sidebar handles nav)

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, authFetch } from "../../lib/api";
import { useLang } from "../../i18n/LangContext";
import LangSwitcher from "../../components/LangSwitcher";
import { useAuth } from "../../auth/useAuth";
import { CVUnfiredAlert } from "../../components/dashboard/CVUnfiredAlert";
import OnboardingModal from "../../components/onboarding/OnboardingModal";

interface DashboardStats {
  faqCount: number;
  bookCount: number;
  publishedFaqCount: number;
  lastUpdated: string | null;
  gapCount: number;
  feedbackUnread: number;
}

// ------------------------------------------------------------------ //
// Skeleton card
// ------------------------------------------------------------------ //
function StatSkeleton() {
  return (
    <div
      style={{
        flex: "1 1 140px",
        borderRadius: 14,
        border: "1px solid var(--border)",
        background: "var(--card)",
        padding: "20px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div className="skeleton" style={{ width: 32, height: 32, borderRadius: 8 }} />
      <div className="skeleton" style={{ width: "55%", height: 28, borderRadius: 6 }} />
      <div className="skeleton" style={{ width: "80%", height: 14, borderRadius: 4 }} />
    </div>
  );
}

// ------------------------------------------------------------------ //
// KPI stat card
// ------------------------------------------------------------------ //
function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  icon: string;
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: "1 1 140px",
        borderRadius: 14,
        border: "1px solid var(--border)",
        background: "var(--card)",
        padding: "20px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 0.15s, box-shadow 0.15s",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
      }}
      onMouseEnter={(e) => { if (onClick) { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = "var(--primary)"; el.style.boxShadow = "0 4px 16px rgba(0,0,0,0.1)"; } }}
      onMouseLeave={(e) => { if (onClick) { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = "var(--border)"; el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.06)"; } }}
    >
      <span style={{ fontSize: 24 }}>{icon}</span>
      <span style={{ fontSize: 28, fontWeight: 700, color: accent ?? "var(--foreground)", lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>{label}</span>
      {sub && <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{sub}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ //
// Quick action button
// ------------------------------------------------------------------ //
function QuickAction({
  icon,
  label,
  onClick,
  variant = "outline",
}: {
  icon: string;
  label: string;
  onClick: () => void;
  variant?: "primary" | "success" | "outline";
}) {
  const bgMap = {
    primary: "linear-gradient(135deg, var(--primary), oklch(62% 0.22 240))",
    success: "linear-gradient(135deg, #22c55e, #4ade80)",
    outline: "var(--card)",
  };
  const colorMap = {
    primary: "#fff",
    success: "#022c22",
    outline: "var(--foreground)",
  };
  const borderMap = {
    primary: "none",
    success: "none",
    outline: "1px solid var(--border)",
  };
  return (
    <button
      onClick={onClick}
      style={{
        flex: "1 1 160px",
        padding: "14px 18px",
        minHeight: 48,
        borderRadius: 10,
        border: borderMap[variant],
        background: bgMap[variant],
        color: colorMap[variant],
        fontSize: 14,
        fontWeight: variant === "outline" ? 600 : 700,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 8,
        transition: "opacity 0.15s",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.85"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
    >
      <span>{icon}</span> {label}
    </button>
  );
}

// ------------------------------------------------------------------ //
// Main
// ------------------------------------------------------------------ //
export default function AdminDashboard() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const { user, isSuperAdmin, logout, previewMode, previewTenantId } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // GID 1216274591838389: 初回ログイン時オンボーディング（client_admin自身の未完了時のみ表示。
  // previewMode中はisSuperAdminがfalseになるため previewMode を明示的に除外する）
  useEffect(() => {
    if (isSuperAdmin || previewMode || !user?.tenantId) return;
    authFetch(`${API_BASE}/v1/admin/my-tenant`)
      .then((r) => r.json())
      .then((data: { onboarding_completed_at?: string | null }) => {
        if (!data.onboarding_completed_at) setShowOnboarding(true);
      })
      .catch(() => {});
  }, [isSuperAdmin, previewMode, user?.tenantId]);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        setError(null);

        const effectiveTenantId = previewMode
          ? (previewTenantId ?? "")
          : (user?.tenantId ?? "");

        const faqParams = new URLSearchParams({ limit: "1", offset: "0" });
        if (effectiveTenantId) faqParams.set("tenantId", effectiveTenantId);

        const knowledgeUrl = effectiveTenantId
          ? `${API_BASE}/v1/admin/knowledge?tenant=${effectiveTenantId}`
          : `${API_BASE}/v1/admin/knowledge`;

        const gapCountUrl = effectiveTenantId
          ? `${API_BASE}/v1/admin/knowledge/gaps/count?tenant=${effectiveTenantId}`
          : `${API_BASE}/v1/admin/knowledge/gaps/count`;

        const [faqRes, bookRes, gapRes, feedbackRes] = await Promise.allSettled([
          authFetch(`${API_BASE}/admin/faqs?${faqParams.toString()}`),
          authFetch(knowledgeUrl),
          authFetch(gapCountUrl),
          authFetch(`${API_BASE}/v1/admin/feedback/unread-count`),
        ]);

        let faqCount = 0;
        let publishedFaqCount = 0;
        let bookCount = 0;
        let lastUpdated: string | null = null;
        let gapCount = 0;
        let feedbackUnread = 0;

        if (faqRes.status === "fulfilled" && faqRes.value.ok) {
          const data = (await faqRes.value.json()) as {
            pagination?: { count?: number };
            items?: Array<{ is_published: boolean; updated_at: string }>;
          };
          faqCount = data.pagination?.count ?? 0;
          if (data.items) {
            publishedFaqCount = data.items.filter((f) => f.is_published).length;
            const latest = data.items.map((f) => f.updated_at).sort().reverse()[0];
            if (latest) lastUpdated = latest;
          }
        }

        if (bookRes.status === "fulfilled" && bookRes.value.ok) {
          const data = (await bookRes.value.json()) as { count?: number; chunkCount?: number; items?: unknown[] };
          bookCount = (data.count ?? data.items?.length ?? 0) + (data.chunkCount ?? 0);
        }

        if (gapRes.status === "fulfilled" && gapRes.value.ok) {
          const data = (await gapRes.value.json()) as { count: number };
          gapCount = data.count ?? 0;
        }

        if (feedbackRes.status === "fulfilled" && feedbackRes.value.ok) {
          const data = (await feedbackRes.value.json()) as { count: number };
          feedbackUnread = data.count ?? 0;
        }

        setStats({ faqCount, publishedFaqCount, bookCount, lastUpdated, gapCount, feedbackUnread });
      } catch {
        setError(t("dashboard.error"));
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [navigate, t]);

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const locale = lang === "en" ? "en-US" : "ja-JP";

  const knowledgePath = isSuperAdmin
    ? "/admin/knowledge"
    : `/admin/knowledge/${previewMode ? (previewTenantId ?? "") : (user?.tenantId ?? "")}`;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
        padding: "32px 28px",
        maxWidth: 880,
      }}
    >
      {/* Page header */}
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
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
            {t("dashboard.title")}
          </h1>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", marginTop: 4, marginBottom: 0 }}>
            全体の状況をひと目で確認できます
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {user && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 10px",
                borderRadius: 999,
                background: "var(--card)",
                border: "1px solid var(--border)",
                fontSize: 12,
                color: "var(--muted-foreground)",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 6px #22c55e", display: "inline-block" }} />
              {t("dashboard.connected")}
            </div>
          )}
          <LangSwitcher />
          <button
            onClick={() => void handleLogout()}
            style={{
              padding: "8px 14px",
              minHeight: 36,
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--muted-foreground)",
              fontSize: 13,
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
            background: "rgba(127,29,29,0.15)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#ef4444",
            fontSize: 15,
          }}
        >
          {error}
        </div>
      )}

      {/* CV alert */}
      <CVUnfiredAlert />

      {/* KPI Cards */}
      <section style={{ marginBottom: 36 }}>
        <h2 style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          現在の状況
        </h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {loading ? (
            <>
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
            </>
          ) : (
            <>
              <StatCard
                icon="💬"
                label={t("dashboard.faq_count")}
                value={stats?.faqCount ?? 0}
                sub={t("dashboard.faq_count_sub")}
                onClick={() => navigate(knowledgePath)}
              />
              <StatCard
                icon="✅"
                label={t("dashboard.published_faq")}
                value={stats?.publishedFaqCount ?? 0}
                accent="#22c55e"
                sub={t("dashboard.published_faq_sub")}
                onClick={() => navigate(knowledgePath)}
              />
              <StatCard
                icon="🔍"
                label="未回答質問"
                value={stats?.gapCount ?? 0}
                accent={(stats?.gapCount ?? 0) > 0 ? "#f59e0b" : undefined}
                sub="AIが答えられなかった質問数"
                onClick={() => navigate("/admin/chat-history")}
              />
              <StatCard
                icon="🕐"
                label={t("dashboard.last_updated")}
                value={
                  stats?.lastUpdated
                    ? new Date(stats.lastUpdated).toLocaleDateString(locale, { month: "short", day: "numeric" })
                    : "—"
                }
                sub={stats?.lastUpdated ? t("dashboard.last_updated_sub") : t("dashboard.no_updates")}
              />
              {isSuperAdmin && (stats?.feedbackUnread ?? 0) > 0 && (
                <StatCard
                  icon="💬"
                  label="未読フィードバック"
                  value={stats?.feedbackUnread ?? 0}
                  accent="#f59e0b"
                  sub="お客様からの新着フィードバック"
                  onClick={() => navigate("/admin/feedback")}
                />
              )}
            </>
          )}
        </div>
      </section>

      {/* Quick Actions */}
      <section>
        <h2 style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          クイックアクション
        </h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <QuickAction icon="🧪" label="テストチャット" onClick={() => navigate("/admin/chat-test")} variant="primary" />
          <QuickAction icon="📚" label="ナレッジ追加" onClick={() => navigate(knowledgePath)} variant="success" />
          <QuickAction icon="⚙️" label="ルール確認" onClick={() => navigate("/admin/tuning")} variant="outline" />
          <QuickAction icon="📈" label="分析を見る" onClick={() => navigate("/admin/analytics")} variant="outline" />
        </div>
      </section>

      {showOnboarding && user?.tenantId && (
        <OnboardingModal tenantId={user.tenantId} onClose={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}
