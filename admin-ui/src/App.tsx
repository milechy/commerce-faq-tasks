import React from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./App.css";
import { LangProvider } from "./i18n/LangContext";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { RequireAuth, SuperAdminRoute } from "./components/RoleGuard";
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
import TuningPage from "./pages/admin/tuning/index";
import KnowledgeGapsPage from "./pages/admin/knowledge-gaps/index";
import FeedbackPage from "./pages/admin/feedback/index";
import FeedbackChat from "./components/feedback/FeedbackChat";
import AdminAIChat from "./components/AdminAIChat";
import AvatarListPage from "./pages/admin/avatar/index";
import AvatarStudioPage from "./pages/admin/avatar/studio";
import { supabaseConfigured } from "./lib/supabaseClient";

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

function AppInner() {
  const { user, isClientAdmin, isSuperAdmin } = useAuth();
  const tenantId = user?.tenantId ?? "";
  const location = useLocation();
  const showAIChat = !!user && location.pathname !== "/admin/chat-test";
  return (
    <>
      <Routes>

        {/* ログイン画面 */}
        <Route path="/login" element={<Login />} />

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
        <Route path="/admin/billing" element={<SuperAdminRoute><BillingPage /></SuperAdminRoute>} />

        {/* チャットテスト */}
        <Route path="/admin/chat-test" element={<RequireAuth><ChatTestPage /></RequireAuth>} />

        {/* 会話履歴 */}
        <Route path="/admin/chat-history" element={<RequireAuth><ChatHistoryPage /></RequireAuth>} />
        <Route path="/admin/chat-history/:sessionId" element={<RequireAuth><ChatHistorySessionPage /></RequireAuth>} />

        {/* チューニングルール */}
        <Route path="/admin/tuning" element={<RequireAuth><TuningPage /></RequireAuth>} />

        {/* ナレッジギャップ */}
        <Route path="/admin/knowledge-gaps" element={<RequireAuth><KnowledgeGapsPage /></RequireAuth>} />

        {/* フィードバック — Super Admin専用 */}
        <Route path="/admin/feedback" element={<SuperAdminRoute><FeedbackPage /></SuperAdminRoute>} />

        {/* アバターカスタマイズスタジオ */}
        <Route path="/admin/avatar" element={<RequireAuth><AvatarListPage /></RequireAuth>} />
        <Route path="/admin/avatar/studio" element={<RequireAuth><AvatarStudioPage /></RequireAuth>} />
        <Route path="/admin/avatar/studio/:id" element={<RequireAuth><AvatarStudioPage /></RequireAuth>} />

        {/* 旧 /faqs → /admin にリダイレクト */}
        <Route path="/faqs" element={<Navigate to="/admin" replace />} />
        <Route path="/faqs/*" element={<Navigate to="/admin" replace />} />

        {/* それ以外のパスは管理ダッシュボードへ */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
      {/* Client Admin用フローティングフィードバックチャット */}
      {isClientAdmin && tenantId && <FeedbackChat tenantId={tenantId} />}
      {/* 管理AIチャット — ログイン済み全ロール、chat-testページを除く */}
      {showAIChat && <AdminAIChat />}
    </>
  );
}

export default function App() {
  // Supabase 未設定時はエラー画面を返す（真っ黒にならない）
  if (!supabaseConfigured) {
    return <ConfigErrorScreen />;
  }

  return (
    <LangProvider>
    <BrowserRouter>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </BrowserRouter>
    </LangProvider>
  );
}
