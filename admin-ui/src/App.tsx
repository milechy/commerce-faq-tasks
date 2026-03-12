import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import { LangProvider } from "./i18n/LangContext";
import FaqList from "./pages/FaqList";
import FaqForm from "./pages/FaqForm";
import Login from "./pages/Login";
import AdminDashboard from "./pages/admin/index";
import KnowledgePage from "./pages/admin/knowledge/index";
import MonitoringPage from "./pages/admin/monitoring/index";
import TenantsPage from "./pages/admin/tenants/index";
import TenantDetailPage from "./pages/admin/tenants/[id]";
import BillingPage from "./pages/admin/billing/index";

export default function App() {
  return (
    <LangProvider>
    <BrowserRouter>
      <Routes>
        {/* ログイン画面 */}
        <Route path="/login" element={<Login />} />

        {/* ルートは管理ダッシュボードへリダイレクト */}
        <Route path="/" element={<Navigate to="/admin" replace />} />

        {/* 管理ダッシュボード */}
        <Route path="/admin" element={<AdminDashboard />} />

        {/* AIナレッジ（書籍PDF）管理 */}
        <Route path="/admin/knowledge" element={<KnowledgePage />} />

        {/* KPI監視ダッシュボード */}
        <Route path="/admin/monitoring" element={<MonitoringPage />} />

        {/* テナント管理 */}
        <Route path="/admin/tenants" element={<TenantsPage />} />
        <Route path="/admin/tenants/:id" element={<TenantDetailPage />} />

        {/* 請求・使用量 */}
        <Route path="/admin/billing" element={<BillingPage />} />

        {/* FAQ 一覧 */}
        <Route path="/faqs" element={<FaqList />} />

        {/* FAQ 作成 / 編集 */}
        <Route path="/faqs/new" element={<FaqForm mode="create" />} />
        <Route path="/faqs/:id/edit" element={<FaqForm mode="edit" />} />

        {/* それ以外のパスは管理ダッシュボードへ */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </BrowserRouter>
    </LangProvider>
  );
}
