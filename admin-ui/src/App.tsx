import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import FaqList from "./pages/FaqList";
import FaqForm from "./pages/FaqForm";
import Login from "./pages/Login";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* ログイン画面 */}
        <Route path="/login" element={<Login />} />

        {/* ルートは FAQ 一覧へリダイレクト */}
        <Route path="/" element={<Navigate to="/faqs" replace />} />

        {/* FAQ 一覧 */}
        <Route path="/faqs" element={<FaqList />} />

        {/* FAQ 作成 / 編集 */}
        <Route path="/faqs/new" element={<FaqForm mode="create" />} />
        <Route path="/faqs/:id/edit" element={<FaqForm mode="edit" />} />

        {/* それ以外のパスは FAQ 一覧へ */}
        <Route path="*" element={<Navigate to="/faqs" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
