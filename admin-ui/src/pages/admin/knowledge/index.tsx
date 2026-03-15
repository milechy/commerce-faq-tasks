import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { SuperAdminOnly } from "../../../components/RoleGuard";
import KnowledgeListTab from "../../../components/knowledge/KnowledgeListTab";
import TextInputTab from "../../../components/knowledge/TextInputTab";
import UrlScrapeTab from "../../../components/knowledge/UrlScrapeTab";
import PdfUploadSection from "../../../components/knowledge/PdfUploadSection";
import { getAccessToken, type Tab } from "../../../components/knowledge/shared";

export default function KnowledgePage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const [activeTab, setActiveTab] = useState<Tab>("list");

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

      {/* PDFアップロード — super_admin のみ */}
      <SuperAdminOnly>
        <PdfUploadSection />
      </SuperAdminOnly>

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
      {activeTab === "list" && <KnowledgeListTab />}
      {activeTab === "text" && <TextInputTab />}
      {activeTab === "scrape" && <UrlScrapeTab onCommitSuccess={() => setActiveTab("list")} />}
    </div>
  );
}
