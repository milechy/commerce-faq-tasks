import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import { LangProvider } from "./i18n/LangContext";
import { AuthProvider } from "./auth/useAuth";
import { RequireAuth, SuperAdminRoute } from "./components/RoleGuard";
import FaqList from "./pages/FaqList";
import FaqForm from "./pages/FaqForm";
import Login from "./pages/Login";
import AdminDashboard from "./pages/admin/index";
import KnowledgePage from "./pages/admin/knowledge/index";
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

        {/* AIナレッジ（書籍PDF）管理 */}
        <Route path="/admin/knowledge" element={<RequireAuth><KnowledgePage /></RequireAuth>} />

        {/* KPI監視ダッシュボード */}
        <Route path="/admin/monitoring" element={<RequireAuth><MonitoringPage /></RequireAuth>} />

        {/* テナント管理 — super_admin 専用 */}
        <Route path="/admin/tenants" element={<SuperAdminRoute><TenantsPage /></SuperAdminRoute>} />
        <Route path="/admin/tenants/:id" element={<SuperAdminRoute><TenantDetailPage /></SuperAdminRoute>} />

        {/* 請求・使用量 — super_admin 専用 */}
        <Route path="/admin/billing" element={<SuperAdminRoute><BillingPage /></SuperAdminRoute>} />

        {/* チャットテスト */}
        <Route path="/admin/chat-test" element={<RequireAuth><ChatTestPage /></RequireAuth>} />

        {/* FAQ 一覧 */}
        <Route path="/faqs" element={<RequireAuth><FaqList /></RequireAuth>} />

        {/* FAQ 作成 / 編集 */}
        <Route path="/faqs/new" element={<RequireAuth><FaqForm mode="create" /></RequireAuth>} />
        <Route path="/faqs/:id/edit" element={<RequireAuth><FaqForm mode="edit" /></RequireAuth>} />

        {/* それ以外のパスは管理ダッシュボードへ */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
      </AuthProvider>
    </BrowserRouter>
    </LangProvider>
  );
}
