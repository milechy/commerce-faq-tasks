// admin-ui/src/pages/admin/knowledge/books.tsx
// Phase52e: 書籍管理はナレッジ管理ページ（PDFタブ）に統合済み → リダイレクト

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function BooksRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/admin/knowledge", { replace: true });
  }, [navigate]);
  return null;
}
