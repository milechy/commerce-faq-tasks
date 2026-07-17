import React from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppSidebar, MobileHeader, MobileBottomBar } from "./components/AppSidebar";
import { PreviewModeBanner, PREVIEW_MODE_BANNER_HEIGHT } from "./components/PreviewModeBanner";
import { ThemeProvider } from "./contexts/ThemeContext";
import "./App.css";
import { LangProvider } from "./i18n/LangContext";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { RequireAuth, SuperAdminRoute, AdminRoute } from "./components/RoleGuard";
import Login from "./pages/Login";
import AdminDashboard from "./pages/admin/index";
import KnowledgeIndexPage from "./pages/admin/knowledge/index";
import TenantKnowledgePage from "./pages/admin/knowledge/[tenantId]";
import MonitoringPage from "./pages/admin/monitoring/index";
import TenantsPage from "./pages/admin/tenants/index";
import TenantDetailPage from "./pages/admin/tenants/[id]";
import BillingPage from "./pages/admin/billing/index";
import ChatTestPage from "./pages/admin/chat-test/index";
import ChatHistoryPage from "./pages/admin/chat-history/index";
import ChatHistorySessionPage from "./pages/admin/chat-history/[sessionId]";
import EscalationsPage from "./pages/admin/escalations/index";
import EscalationDetailPage from "./pages/admin/escalations/[sessionId]";
import KnowledgeGapsPage from "./pages/admin/knowledge-gaps/index";
import TuningPage from "./pages/admin/tuning/index";
import FeedbackPage from "./pages/admin/feedback/index";
import AdminAgentButton from "./components/AdminAgent/AdminAgentButton";
import AdminAgentPanel from "./components/AdminAgent/AdminAgentPanel";
import AvatarListPage from "./pages/admin/avatar/index";
import AvatarStudioPage from "./pages/admin/avatar/studio";
import AvatarWizardPage from "./pages/admin/avatar/wizard";
import AvatarDefaultsPage from "./pages/admin/avatar-defaults/index";
import BooksPage from "./pages/admin/knowledge/books";
import KnowledgeAnalyticsPage from "./pages/admin/knowledge/analytics";
import AnalyticsDashboardPage from "./pages/admin/analytics/index";
import CvStatusPage from "./pages/admin/analytics/cv-status";
import FlowAnalyticsPage from "./pages/admin/analytics/FlowAnalyticsPage";
import EngagementPage from "./pages/admin/engagement/index";
import ConversionDashboardPage from "./pages/admin/conversion/index";
import OptionManagementPage from "./pages/admin/options/index";
import ResetPasswordPage from "./pages/ResetPassword";
import AuthBridgePage from "./pages/AuthBridgePage";
// 【追加専用・プロトタイプ】テナント向けチャット・ファースト管理画面のUX検証ページ。
// 認証ゲート外の隔離ルート。既存の管理画面には一切影響しない。URL: /copilot-preview
import CopilotPreviewPage from "./pages/copilot-preview/index";
import { AdminAgentUIProvider, useAdminAgentUI } from "./contexts/AdminAgentUIContext";
import { supabaseConfigured } from "./lib/supabaseClient";
import { isChatFirstDefaultEnabled } from "./lib/chatFirstDefault";

// ─── 層2: Supabase 未設定ガード ───────────────────────────────────────────────
// supabaseConfigured=false の場合、Reactはマウントできるが
// Supabase依存の全コンポーネントを描画しない。真っ黒にはならない。
const CONFIG_ERROR_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
  background: "#0f172a",
  color: "#f9fafb",
  fontFamily: "system-ui, -apple-system, sans-serif",
  padding: "24px",
  textAlign: "center",
};

function ConfigErrorScreen() {
  return (
    <div style={CONFIG_ERROR_STYLE}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, color: "#fca5a5" }}>
        設定エラー — Supabase 未設定
      </h1>
      <p style={{ fontSize: 15, color: "#9ca3af", maxWidth: 480, lineHeight: 1.7, marginBottom: 20 }}>
        <code style={{ background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: 4 }}>
          VITE_SUPABASE_URL
        </code>{" "}または{" "}
        <code style={{ background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: 4 }}>
          VITE_SUPABASE_ANON_KEY
        </code>{" "}
        がビルド時に設定されていません。
      </p>
      <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid #374151", borderRadius: 10, padding: "14px 20px", fontSize: 13, color: "#6b7280", maxWidth: 460, textAlign: "left" }}>
        <strong style={{ color: "#d1d5db" }}>対処方法:</strong><br />
        VPS: <code>/opt/rajiuce/admin-ui/.env.local</code> に設定後、<br />
        <code>cd admin-ui &amp;&amp; pnpm build &amp;&amp; pm2 restart rajiuce-admin</code>
      </div>
    </div>
  );
}

// build-hash cache-bust 2026-07-17: Cloudflare Pages エッジで /assets/*.js に
// 誤って index.html の SPA fallback がキャッシュされる不整合(immutable設定のため
// 自然回復しない)を、ファイル名ハッシュを変えて新規URLに切り替えることで回避する。
// (console.* は vite.config.ts の terser drop_console:true で消えるため window 代入を使う)
if (typeof window !== "undefined") {
  (window as unknown as Record<string, string>).__r2cAdminBuildTag = "20260717-1";
}

function AppInner() {
  const { isClientAdmin, isSuperAdmin, user, previewMode, previewTenantId } = useAuth();
  const { isOpen: agentOpen, seedQuery, toggle: toggleAgent, close: closeAgent } = useAdminAgentUI();
  const location = useLocation();
  const showAIChat = isClientAdmin && location.pathname !== "/admin/chat-test";
  const isAdmin = location.pathname.startsWith("/admin") || location.pathname === "/";
  const isLogin =
    location.pathname === "/login" || location.pathname === "/reset-password";
  const isAuthBridge = location.pathname === "/auth/bridge";
  // 【追加専用・プロトタイプ】チャット・ファースト管理画面のプレビュー。
  // 認証ゲートより手前で隔離返却するため、既存のルート/サイドバー/認可には触れない。
  // Phase4: このブラウザだけの個人オプトイン(localStorage)で有効化した場合のみ、
  // 従来のランディング(/ , /admin)からもこの画面に入る。既定は無効=従来のダッシュボードのまま。
  // テナント全体・他ユーザーの挙動には一切影響しない。
  const isLandingPath = location.pathname === "/" || location.pathname === "/admin";
  const isCopilotPreview =
    location.pathname === "/copilot-preview" || (isLandingPath && isChatFirstDefaultEnabled());

  if (isAuthBridge) {
    return (
      <Routes>
        <Route path="/auth/bridge" element={<AuthBridgePage />} />
      </Routes>
    );
  }

  if (isCopilotPreview) {
    return <CopilotPreviewPage />;
  }

  if (isLogin) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div className="app-layout">
      {isAdmin && <AppSidebar />}
      <div className="app-main">
        <PreviewModeBanner />
        {previewMode && <div style={{ height: PREVIEW_MODE_BANNER_HEIGHT }} />}
        {isAdmin && <MobileHeader />}
        {isAdmin && <MobileBottomBar />}
        <Routes>

        {/* ルートは管理ダッシュボードへリダイレクト */}
        <Route path="/" element={<Navigate to="/admin" replace />} />

        {/* 管理ダッシュボード */}
        <Route path="/admin" element={<RequireAuth><AdminDashboard /></RequireAuth>} />

        {/* ナレッジ管理 — テナント選択 */}
        <Route path="/admin/knowledge" element={<RequireAuth><KnowledgeIndexPage /></RequireAuth>} />

        {/* ナレッジ管理 — グローバル (super_admin 専用) */}
        <Route path="/admin/knowledge/global" element={<SuperAdminRoute><TenantKnowledgePage /></SuperAdminRoute>} />

        {/* ナレッジ管理 — テナント別 */}
        <Route path="/admin/knowledge/:tenantId" element={<RequireAuth><TenantKnowledgePage /></RequireAuth>} />

        {/* KPI監視ダッシュボード */}
        <Route path="/admin/monitoring" element={<RequireAuth><MonitoringPage /></RequireAuth>} />

        {/* テナント管理 — super_admin 専用 */}
        <Route path="/admin/tenants" element={<SuperAdminRoute><TenantsPage /></SuperAdminRoute>} />
        <Route path="/admin/tenants/:id" element={<SuperAdminRoute><TenantDetailPage /></SuperAdminRoute>} />

        {/* 請求・使用量 — super_admin 専用 */}
        <Route path="/admin/billing" element={<AdminRoute><BillingPage /></AdminRoute>} />

        {/* チャットテスト */}
        <Route path="/admin/chat-test" element={<RequireAuth><ChatTestPage /></RequireAuth>} />

        {/* 会話履歴 */}
        <Route path="/admin/chat-history" element={<RequireAuth><ChatHistoryPage /></RequireAuth>} />
        <Route path="/admin/chat-history/:sessionId" element={<RequireAuth><ChatHistorySessionPage /></RequireAuth>} />

        {/* GID 1216275508391900: 有人チャットへのシームレスエスカレーション */}
        <Route path="/admin/escalations" element={<RequireAuth><EscalationsPage /></RequireAuth>} />
        <Route path="/admin/escalations/:sessionId" element={<RequireAuth><EscalationDetailPage /></RequireAuth>} />

        {/* チューニングルール */}
        <Route path="/admin/tuning" element={<RequireAuth><TuningPage /></RequireAuth>} />

        {/* GID 1216275179995736: 未回答質問からのワンクリック改善導線 */}
        <Route path="/admin/knowledge-gaps" element={<RequireAuth><KnowledgeGapsPage /></RequireAuth>} />

        {/* フィードバック — Super Admin専用 */}
        <Route path="/admin/feedback" element={<SuperAdminRoute><FeedbackPage /></SuperAdminRoute>} />

        {/* アバターカスタマイズスタジオ */}
        <Route path="/admin/avatar" element={<RequireAuth><AvatarListPage /></RequireAuth>} />
        <Route path="/admin/avatar/wizard" element={<RequireAuth><AvatarWizardPage /></RequireAuth>} />
        <Route path="/admin/avatar/studio" element={<RequireAuth><AvatarStudioPage /></RequireAuth>} />
        <Route path="/admin/avatar/studio/:id" element={<RequireAuth><AvatarStudioPage /></RequireAuth>} />

        {/* デフォルトアバター管理 — Super Admin専用 */}
        <Route path="/admin/avatar-defaults" element={<SuperAdminRoute><AvatarDefaultsPage /></SuperAdminRoute>} />

        {/* 書籍管理 */}
        <Route path="/admin/knowledge/books" element={<RequireAuth><BooksPage /></RequireAuth>} />

        {/* AI学習・貢献分析 — super_admin 専用（OpenClaw 横断分析） */}
        <Route path="/admin/knowledge-analytics" element={<SuperAdminRoute><KnowledgeAnalyticsPage /></SuperAdminRoute>} />

        {/* Phase45: AI評価 — 廃止: /admin/chat-history にリダイレクト */}
        <Route path="/admin/evaluations" element={<Navigate to="/admin/chat-history" replace />} />
        <Route path="/admin/evaluations/:id" element={<Navigate to="/admin/chat-history" replace />} />

        {/* Phase50: 会話分析ダッシュボード */}
        <Route path="/admin/analytics" element={<RequireAuth><AnalyticsDashboardPage /></RequireAuth>} />
        {/* Phase65-3: CV発火状況 — super_admin 専用 */}
        <Route path="/admin/analytics/cv-status" element={<SuperAdminRoute><CvStatusPage /></SuperAdminRoute>} />
        {/* Phase72-C: フロー遷移分析 — super_admin 専用 */}
        <Route path="/admin/analytics/flow" element={<SuperAdminRoute><FlowAnalyticsPage /></SuperAdminRoute>} />
        <Route path="/admin/engagement" element={<RequireAuth><EngagementPage /></RequireAuth>} />

        {/* Phase58: コンバージョン最適化ダッシュボード */}
        <Route path="/admin/conversion" element={<RequireAuth><ConversionDashboardPage /></RequireAuth>} />

        {/* Phase63: オプション代行管理 — Super Admin専用 */}
        <Route path="/admin/options" element={<SuperAdminRoute><OptionManagementPage /></SuperAdminRoute>} />

        {/* 旧 /faqs → /admin にリダイレクト */}
        <Route path="/faqs" element={<Navigate to="/admin" replace />} />
        <Route path="/faqs/*" element={<Navigate to="/admin" replace />} />

        {/* それ以外のパスは管理ダッシュボードへ */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
      {/* R2C AIアシスタント（✨）に一本化 — 旧サポートAI(AdminAIChat「?」)のFABは撤去 */}
      {/* super_admin/client_admin 共通、chat-testページを除く */}
      {showAIChat && (
        <>
          <AdminAgentButton
            onClick={toggleAgent}
            isOpen={agentOpen}
          />
          {/* previewMode中は isClientAdmin が true になり showAIChat が表示されるが、
              実ログインユーザー(super_admin)の user?.tenantId は常にnullのため
              previewTenantId を優先しないとAIアシスタントがテナント無しで動作してしまう */}
          <AdminAgentPanel
            isOpen={agentOpen}
            onClose={closeAgent}
            tenantId={previewMode ? (previewTenantId ?? null) : (user?.tenantId ?? null)}
            isSuperAdmin={isSuperAdmin}
            initialQuery={seedQuery}
          />
        </>
      )}
      </div>
    </div>
  );
}

export default function App() {
  // Supabase 未設定時はエラー画面を返す（真っ黒にならない）
  if (!supabaseConfigured) {
    return <ConfigErrorScreen />;
  }

  return (
    <ThemeProvider>
    <LangProvider>
    <BrowserRouter>
      <AuthProvider>
        <AdminAgentUIProvider>
          <AppInner />
        </AdminAgentUIProvider>
      </AuthProvider>
    </BrowserRouter>
    </LangProvider>
    </ThemeProvider>
  );
}
