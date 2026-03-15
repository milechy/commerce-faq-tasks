import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import { LangProvider } from "./i18n/LangContext";
import { AuthProvider } from "./auth/useAuth";
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

export default function App() {
  return (
    <LangProvider>
    <BrowserRouter>
      <AuthProvider>
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

        {/* 旧 /faqs → /admin にリダイレクト */}
        <Route path="/faqs" element={<Navigate to="/admin" replace />} />
        <Route path="/faqs/*" element={<Navigate to="/admin" replace />} />

        {/* それ以外のパスは管理ダッシュボードへ */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
      </AuthProvider>
    </BrowserRouter>
    </LangProvider>
  );
}
