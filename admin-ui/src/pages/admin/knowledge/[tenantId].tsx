import { useEffect, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { API_BASE } from "../../../lib/api";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { useAuth } from "../../../auth/useAuth";
import KnowledgeAttributionTab from "../../../components/knowledge/KnowledgeAttributionTab";
import KnowledgeListTab from "../../../components/knowledge/KnowledgeListTab";
import TextInputTab from "../../../components/knowledge/TextInputTab";
import ScrapeTab from "../../../components/knowledge/UrlScrapeTab";
import PdfUploadTab, { BookUploadsSection } from "../../../components/knowledge/PdfUploadTab";
import { getAccessToken, fetchWithAuth } from "../../../components/knowledge/shared";
import { KNOWLEDGE_TENANT_STORAGE_KEY } from "./index";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

type Tab = "list" | "text" | "scrape" | "pdf" | "attribution";

// ─── メインページ ─────────────────────────────────────────────────────────────

export default function TenantKnowledgePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLang();
  const { tenantId } = useParams<{ tenantId: string }>();
  const { user, isSuperAdmin } = useAuth();

  const searchParams = new URLSearchParams(location.search);
  const tabParam = searchParams.get("tab") as Tab | null;
  const gapId = searchParams.get("gap_id") ? Number(searchParams.get("gap_id")) : undefined;
  const gapQuestion = searchParams.get("question") ?? undefined;

  const [activeTab, setActiveTab] = useState<Tab>(
    tabParam === "text" ||
      tabParam === "scrape" ||
      tabParam === "pdf" ||
      tabParam === "attribution"
      ? tabParam
      : "list"
  );

  // テナント一覧（Super Admin のみ使用）
  const [tenants, setTenants] = useState<Tenant[]>([]);
  useEffect(() => {
    if (!isSuperAdmin) return;
    fetchWithAuth(`${API_BASE}/v1/admin/tenants`)
      .then((res) => res.json() as Promise<{ tenants?: Tenant[]; items?: Tenant[] }>)
      .then((data) => setTenants(data.tenants ?? data.items ?? []))
      .catch(() => {/* best-effort */});
  }, [isSuperAdmin]);

  // tenantId の解決: URL params → pathnameの末尾 → JWTのtenantId
  // /admin/knowledge/global のように固定パスの場合 useParams では undefined になるため
  // pathname から取得するフォールバックを追加
  const pathTenantId = tenantId ?? location.pathname.split("/").pop() ?? "";
  const resolvedTenantId = pathTenantId || user?.tenantId || "";

  // テナント切り替え時に localStorage に保存
  useEffect(() => {
    if (isSuperAdmin && resolvedTenantId) {
      localStorage.setItem(KNOWLEDGE_TENANT_STORAGE_KEY, resolvedTenantId);
    }
  }, [isSuperAdmin, resolvedTenantId]);

  useEffect(() => {
    void (async () => {
      const token = await getAccessToken();
      if (!token) navigate("/login", { replace: true });
    })();
  }, [navigate]);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "list", label: t("knowledge.tab_list"), icon: "📋" },
    { id: "text", label: t("knowledge.tab_text"), icon: "✏️" },
    { id: "scrape", label: t("knowledge.tab_scrape"), icon: "🌐" },
    { id: "pdf", label: "PDFアップロード", icon: "📚" },
    { id: "attribution", label: "CV影響度", icon: "📈" },
  ];

  const isGlobalTenant = resolvedTenantId === "global";

  const handleTenantChange = (newTenantId: string) => {
    localStorage.setItem(KNOWLEDGE_TENANT_STORAGE_KEY, newTenantId);
    const tabSuffix = activeTab !== "list" ? `?tab=${activeTab}` : "";
    navigate(`/admin/knowledge/${newTenantId}${tabSuffix}`);
  };

  const testUrl = isGlobalTenant
    ? "/admin/chat-test?scope=global"
    : `/admin/chat-test?tenantId=${encodeURIComponent(resolvedTenantId)}`;

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
        {isSuperAdmin ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <select
              value={resolvedTenantId}
              onChange={(e) => handleTenantChange(e.target.value)}
              style={{
                flex: 1, padding: "10px 12px", minHeight: 44, borderRadius: 10,
                border: "1px solid #374151", background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb", fontSize: 15, cursor: "pointer",
              }}
            >
              <option value="global">🌐 グローバルナレッジ</option>
              {tenants.map((tn) => (
                <option key={tn.id} value={tn.id}>{tn.name}</option>
              ))}
            </select>
            <button
              onClick={() => navigate(testUrl)}
              style={{
                padding: "10px 16px", minHeight: 44, borderRadius: 10,
                border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.08)",
                color: "#93c5fd", fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              💬 テスト
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button
              onClick={() => navigate(testUrl)}
              style={{
                padding: "10px 16px", minHeight: 44, borderRadius: 10,
                border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.08)",
                color: "#93c5fd", fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}
            >
              💬 テスト
            </button>
          </div>
        )}
      </header>

      {/* タブ */}
      <div style={{ display: "flex", gap: 0, marginBottom: 24, borderBottom: "1px solid #1f2937" }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "12px 20px",
              minHeight: 48,
              border: "none",
              borderBottom: `2px solid ${activeTab === tab.id ? "#22c55e" : "transparent"}`,
              background: "transparent",
              color: activeTab === tab.id ? "#4ade80" : "#9ca3af",
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 700 : 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              transition: "color 0.15s",
            }}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* タブコンテンツ */}
      {activeTab === "list" && (
        <>
          <KnowledgeListTab tenantId={resolvedTenantId} />
          {isGlobalTenant && <BookUploadsSection tenantId={resolvedTenantId} />}
        </>
      )}
      {activeTab === "text" && <TextInputTab tenantId={resolvedTenantId} gapQuestion={gapQuestion} gapId={gapId} />}
      {activeTab === "scrape" && <ScrapeTab tenantId={resolvedTenantId} onCommitSuccess={() => setActiveTab("list")} gapQuestion={gapQuestion} gapId={gapId} />}
      {activeTab === "pdf" && <PdfUploadTab tenantId={resolvedTenantId} />}
      {activeTab === "attribution" && (
        <KnowledgeAttributionTab tenantId={resolvedTenantId} />
      )}
    </div>
  );
}
