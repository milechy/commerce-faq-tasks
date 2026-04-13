// admin-ui/src/pages/admin/index.tsx
// Phase52g: ダッシュボード — 4セクション構成 + KPIサマリー

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, authFetch } from "../../lib/api";
import { useLang } from "../../i18n/LangContext";
import LangSwitcher from "../../components/LangSwitcher";
import { useAuth } from "../../auth/useAuth";

interface DashboardStats {
  faqCount: number;
  bookCount: number;
  publishedFaqCount: number;
  lastUpdated: string | null;
  gapCount: number;
  feedbackUnread: number;
}

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
        border: "1px solid #1f2937",
        background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
        padding: "20px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 0.15s",
      }}
      onMouseEnter={(e) => { if (onClick) (e.currentTarget as HTMLDivElement).style.borderColor = "#374151"; }}
      onMouseLeave={(e) => { if (onClick) (e.currentTarget as HTMLDivElement).style.borderColor = "#1f2937"; }}
    >
      <span style={{ fontSize: 28 }}>{icon}</span>
      <span style={{ fontSize: 28, fontWeight: 700, color: accent ?? "#f9fafb", lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#d1d5db" }}>{label}</span>
      {sub && <span style={{ fontSize: 12, color: "#6b7280" }}>{sub}</span>}
    </div>
  );
}

interface NavSectionItem {
  label: string;
  desc: string;
  path: string;
  badge?: number;
  badgeColor?: string;
}

interface NavSection {
  icon: string;
  title: string;
  color: string;
  items: NavSectionItem[];
}

function SectionCard({ section, navigate }: { section: NavSection; navigate: (path: string) => void }) {
  return (
    <div
      style={{
        flex: "1 1 240px",
        borderRadius: 14,
        border: "1px solid #1f2937",
        background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
        overflow: "hidden",
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
      }}
    >
      {/* Section header */}
      <div
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid #1f2937",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 20 }}>{section.icon}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: "#f9fafb" }}>{section.title}</span>
      </div>

      {/* Items */}
      <div>
        {section.items.map((item) => (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              textAlign: "left",
              padding: "12px 18px",
              background: "none",
              border: "none",
              borderBottom: "1px solid rgba(31,41,55,0.4)",
              cursor: "pointer",
              minHeight: 52,
              gap: 8,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.03)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "none";
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb" }}>{item.label}</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{item.desc}</div>
            </div>
            {item.badge != null && item.badge > 0 && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: item.badgeColor ? `${item.badgeColor}25` : "rgba(59,130,246,0.2)",
                  border: `1px solid ${item.badgeColor ? `${item.badgeColor}55` : "rgba(59,130,246,0.4)"}`,
                  color: item.badgeColor ?? "#60a5fa",
                  fontSize: 11,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {item.badge}
              </span>
            )}
            <span style={{ color: "#4b5563", fontSize: 14, flexShrink: 0 }}>→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const { user, isSuperAdmin, logout, previewMode, previewTenantId, previewTenantName, exitPreview } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // 4-section nav definition (role-filtered)
  const navSections: NavSection[] = [
    {
      icon: "💬",
      title: "会話",
      color: "#60a5fa",
      items: [
        { label: "会話履歴", desc: "お客様との全チャットログ・AI品質評価を確認", path: "/admin/chat-history" },
        ...(isSuperAdmin
          ? [{ label: "お客様の声", desc: `フィードバック管理${(stats?.feedbackUnread ?? 0) > 0 ? "" : ""}`, path: "/admin/feedback", badge: stats?.feedbackUnread, badgeColor: "#60a5fa" }]
          : []),
      ],
    },
    {
      icon: "📚",
      title: "ナレッジ",
      color: "#4ade80",
      items: [
        { label: "ナレッジ管理", desc: "AIが使う回答データを管理します", path: knowledgePath },
        { label: "未回答質問", desc: "AIが答えられなかった質問を管理", path: "/admin/chat-history?has_knowledge_gaps=true", badge: stats?.gapCount, badgeColor: "#fbbf24" },
      ],
    },
    {
      icon: "📈",
      title: "分析",
      color: "#a78bfa",
      items: [
        { label: "会話分析ダッシュボード", desc: "KPI・トレンド・コンバージョン分析", path: "/admin/analytics" },
      ],
    },
    {
      icon: "⚙️",
      title: "設定",
      color: "#9ca3af",
      items: [
        { label: "アバター設定", desc: "AIアバターの見た目と声を設定", path: "/admin/avatar" },
        { label: "チューニングルール", desc: "AIの回答を改善するルールを設定", path: "/admin/tuning" },
        { label: "テストチャット", desc: "AIの回答をリアルタイムにテスト", path: "/admin/chat-test" },
        ...(isSuperAdmin
          ? [
              { label: "テナント管理", desc: "登録テナントの設定と管理", path: "/admin/tenants" },
              { label: "請求・使用量", desc: "API使用量と請求情報を確認", path: "/admin/billing" },
            ]
          : []),
      ],
    },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      {previewMode && <div style={{ height: 44 }} />}

      {/* プレビューモードバナー */}
      {previewMode && (
        <div
          style={{
            position: "fixed",
            top: 52,
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

      {/* Page header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 28,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb", display: "flex", alignItems: "center", gap: 8 }}>
            📊 {t("dashboard.title")}
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
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
                background: "rgba(15,23,42,0.9)",
                border: "1px solid #1f2937",
                fontSize: 12,
                color: "#9ca3af",
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
          )}
          <LangSwitcher />
          <button
            onClick={() => void handleLogout()}
            style={{
              padding: "8px 14px",
              minHeight: 36,
              borderRadius: 8,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 120, color: "#9ca3af", fontSize: 15 }}>
          <span style={{ marginRight: 8 }}>⏳</span>
          {t("dashboard.loading")}
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "#6b7280", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              現在の状況
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
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
                accent="#4ade80"
                sub={t("dashboard.published_faq_sub")}
                onClick={() => navigate(knowledgePath)}
              />
              <StatCard
                icon="🔍"
                label="未回答質問"
                value={stats?.gapCount ?? 0}
                accent={(stats?.gapCount ?? 0) > 0 ? "#fbbf24" : undefined}
                sub="AIが答えられなかった質問数"
                onClick={() => navigate("/admin/chat-history?has_knowledge_gaps=true")}
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
            </div>
          </section>

          {/* 4-section navigation */}
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "#6b7280", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              メニュー
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              {navSections.map((section) => (
                <SectionCard key={section.title} section={section} navigate={navigate} />
              ))}
            </div>
          </section>

          {/* Quick Actions */}
          <section>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "#6b7280", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              クイックアクション
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <button
                onClick={() => navigate("/admin/chat-test")}
                style={{
                  flex: "1 1 180px",
                  padding: "14px 18px",
                  minHeight: 48,
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg, #3b82f6, #60a5fa)",
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  boxShadow: "0 4px 16px rgba(59,130,246,0.3)",
                }}
              >
                <span>🧪</span> テストチャット
              </button>

              <button
                onClick={() => navigate(knowledgePath)}
                style={{
                  flex: "1 1 180px",
                  padding: "14px 18px",
                  minHeight: 48,
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg, #22c55e, #4ade80)",
                  color: "#022c22",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  boxShadow: "0 4px 16px rgba(34,197,94,0.25)",
                }}
              >
                <span>📚</span> ナレッジ追加
              </button>

              <button
                onClick={() => navigate("/admin/tuning")}
                style={{
                  flex: "1 1 180px",
                  padding: "14px 18px",
                  minHeight: 48,
                  borderRadius: 10,
                  border: "1px solid #374151",
                  background: "rgba(15,23,42,0.8)",
                  color: "#e5e7eb",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>⚙️</span> ルール確認
              </button>

              <button
                onClick={() => navigate("/admin/analytics")}
                style={{
                  flex: "1 1 180px",
                  padding: "14px 18px",
                  minHeight: 48,
                  borderRadius: 10,
                  border: "1px solid #374151",
                  background: "rgba(15,23,42,0.8)",
                  color: "#e5e7eb",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>📈</span> 分析を見る
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
