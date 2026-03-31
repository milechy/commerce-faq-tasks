// admin-ui/src/pages/admin/knowledge/books.tsx
// Phase44 P1 — パートナー向け書籍管理UI

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface Book {
  id: number;
  title: string;
  original_filename?: string;
  status: "uploaded" | "processing" | "chunked" | "embedded" | "error";
  page_count?: number | null;
  chunk_count?: number | null;
  file_size_bytes?: number | null;
  created_at: string;
  error_message?: string | null;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: "starter" | "pro";
  status: "active" | "inactive";
}

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

// ─── ステータスバッジ ─────────────────────────────────────────────────────────

function StatusBadge({ status, errorMessage }: { status: Book["status"]; errorMessage?: string | null }) {
  const configs: Record<Book["status"], { label: string; color: string; bg: string; border: string }> = {
    uploaded:   { label: "📤 アップロード済", color: "#93c5fd", bg: "rgba(59,130,246,0.1)",  border: "rgba(59,130,246,0.3)" },
    processing: { label: "⏳ 処理中",        color: "#fbbf24", bg: "rgba(245,158,11,0.1)",  border: "rgba(245,158,11,0.3)" },
    chunked:    { label: "📊 構造化完了",    color: "#c4b5fd", bg: "rgba(139,92,246,0.1)",  border: "rgba(139,92,246,0.3)" },
    embedded:   { label: "✅ 完了",          color: "#4ade80", bg: "rgba(34,197,94,0.1)",   border: "rgba(34,197,94,0.3)" },
    error:      { label: "❌ エラー",        color: "#f87171", bg: "rgba(239,68,68,0.1)",   border: "rgba(239,68,68,0.3)" },
  };
  const cfg = configs[status];
  return (
    <span
      title={status === "error" && errorMessage ? errorMessage : undefined}
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: cfg.color,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        whiteSpace: "nowrap",
        cursor: status === "error" && errorMessage ? "help" : "default",
      }}
    >
      {cfg.label}
      {status === "processing" && (
        <span style={{ display: "inline-block", marginLeft: 8, width: 60, height: 4, borderRadius: 999, background: "rgba(245,158,11,0.2)", verticalAlign: "middle", position: "relative", overflow: "hidden" }}>
          <span style={{
            position: "absolute",
            left: 0, top: 0, height: "100%",
            width: "40%",
            background: "#fbbf24",
            borderRadius: 999,
            animation: "progress-slide 1.5s ease-in-out infinite",
          }} />
        </span>
      )}
    </span>
  );
}

// ─── メインコンポーネント ─────────────────────────────────────────────────────

export default function BooksPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, isSuperAdmin, isLoading: authLoading } = useAuth();

  // テナント選択（Super Admin用）
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>(() => searchParams.get("tenantId") ?? "");

  // 書籍リスト
  const [books, setBooks] = useState<Book[]>([]);
  const [booksLoading, setBooksLoading] = useState(false);

  // アップロードフォーム
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);

  // 操作中
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // トースト
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // バリデーションエラー
  const [fileError, setFileError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);

  // 構造化ステータス
  const [structStatus, setStructStatus] = useState<{ total_docs: number; structured_count: number; unstructured_count: number } | null>(null);
  const [structTriggering, setStructTriggering] = useState(false);

  // ポーリング
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // レスポンシブ
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  // ─── トースト表示 ─────────────────────────────────────────────────────────

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  // ─── テナント取得（Super Admin） ─────────────────────────────────────────

  useEffect(() => {
    if (!isSuperAdmin) return;
    authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((r) => r.json())
      .then((data: { tenants?: Tenant[]; items?: Tenant[] }) => {
        const list = data.tenants ?? data.items ?? [];
        setTenants(list);
        if (!selectedTenantId && list.length > 0) {
          setSelectedTenantId(list[0].id);
        }
      })
      .catch(() => {});
  }, [isSuperAdmin]);

  // ─── 有効なtenantId確定 ───────────────────────────────────────────────────

  const effectiveTenantId = isSuperAdmin ? selectedTenantId : (user?.tenantId ?? "");

  // ─── 構造化ステータス取得 ─────────────────────────────────────────────────

  const fetchStructStatus = useCallback(async () => {
    if (!effectiveTenantId) return;
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge/structurize-status?tenant_id=${encodeURIComponent(effectiveTenantId)}`);
      if (!res.ok) return;
      const data = await res.json() as { total_docs: number; structured_count: number; unstructured_count: number };
      setStructStatus(data);
    } catch {
      // ignore
    }
  }, [effectiveTenantId]);

  // ─── 書籍リスト取得 ───────────────────────────────────────────────────────

  const fetchBooks = useCallback(async () => {
    if (!effectiveTenantId) return;
    setBooksLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge/book-pdf?tenantId=${encodeURIComponent(effectiveTenantId)}`);
      if (!res.ok) return;
      const data = await res.json() as { books?: Book[]; items?: Book[] };
      setBooks(data.books ?? data.items ?? []);
    } catch {
      // ignore
    } finally {
      setBooksLoading(false);
    }
  }, [effectiveTenantId]);

  useEffect(() => {
    if (!authLoading && effectiveTenantId) {
      void fetchBooks();
    }
  }, [authLoading, effectiveTenantId, fetchBooks]);

  useEffect(() => {
    if (!authLoading && effectiveTenantId) {
      void fetchStructStatus();
    }
  }, [authLoading, effectiveTenantId, fetchStructStatus]);

  // ─── ポーリング（processing中の書籍がある場合） ──────────────────────────

  useEffect(() => {
    const hasProcessing = books.some((b) => b.status === "processing");
    if (hasProcessing && !pollingRef.current) {
      pollingRef.current = setInterval(() => { void fetchBooks(); }, 5000);
    } else if (!hasProcessing && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [books, fetchBooks]);

  // ─── ファイル選択処理 ─────────────────────────────────────────────────────

  const validateAndSetFile = (f: File): boolean => {
    setFileError(null);
    if (!f.type.includes("pdf") && !f.name.toLowerCase().endsWith(".pdf")) {
      setFileError("PDFファイルのみアップロードできます");
      return false;
    }
    if (f.size > MAX_FILE_SIZE) {
      setFileError("ファイルサイズが大きすぎます（上限: 50MB）");
      return false;
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.pdf$/i, ""));
    return true;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) validateAndSetFile(dropped);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) validateAndSetFile(f);
  };

  // ─── アップロード ─────────────────────────────────────────────────────────

  const handleUpload = async () => {
    setTitleError(null);
    if (!file) return;
    if (!title.trim()) {
      setTitleError("書籍のタイトルを入力してください");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title.trim());
      if (effectiveTenantId) fd.append("tenantId", effectiveTenantId);
      const res = await authFetch(
        `${API_BASE}/v1/admin/knowledge/book-pdf`,
        { method: "POST", body: fd }
      );
      if (!res.ok) throw new Error("upload failed");
      showToast("アップロードしました！", true);
      setFile(null);
      setTitle("");
      await fetchBooks();
    } catch {
      showToast("アップロードに失敗しました。もう一度お試しください", false);
    } finally {
      setUploading(false);
    }
  };

  // ─── 処理開始 ─────────────────────────────────────────────────────────────

  const handleProcess = async (id: number) => {
    setProcessingId(id);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/knowledge/book-pdf/${id}/process?tenantId=${encodeURIComponent(effectiveTenantId)}`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error("process failed");
      showToast("処理を開始しました", true);
      await fetchBooks();
    } catch {
      showToast("処理の開始に失敗しました。もう一度お試しください", false);
    } finally {
      setProcessingId(null);
    }
  };

  // ─── 削除 ─────────────────────────────────────────────────────────────────

  const handleDelete = async (id: number) => {
    const confirmed = window.confirm("本当に削除しますか？この操作は取り消せません。");
    if (!confirmed) return;
    setDeletingId(id);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/knowledge/book-pdf/${id}?tenantId=${encodeURIComponent(effectiveTenantId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("delete failed");
      showToast("削除しました", true);
      setBooks((prev) => prev.filter((b) => b.id !== id));
    } catch {
      showToast("削除に失敗しました。もう一度お試しください", false);
    } finally {
      setDeletingId(null);
    }
  };

  // ─── 構造化トリガー（super_admin） ───────────────────────────────────────

  const handleStructurizeTrigger = async () => {
    setStructTriggering(true);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/knowledge/structurize-trigger?tenant_id=${encodeURIComponent(effectiveTenantId)}`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error('trigger failed');
      const data = await res.json() as { message: string; target_count: number };
      showToast(`${data.message}（${data.target_count}件対象）`, true);
      setTimeout(() => void fetchStructStatus(), 2000);
    } catch {
      showToast('構造化の開始に失敗しました', false);
    } finally {
      setStructTriggering(false);
    }
  };

  // ─── ロード中 ─────────────────────────────────────────────────────────────

  if (authLoading) return null;

  // ─── レンダリング ─────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 960, margin: "0 auto" }}>

      {/* アニメーション */}
      <style>{`
        @keyframes progress-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>

      {/* トースト */}
      {toast && (
        <div style={{
          position: "fixed",
          top: 20,
          right: 20,
          zIndex: 9999,
          padding: "14px 20px",
          borderRadius: 12,
          background: toast.ok ? "rgba(5,46,22,0.95)" : "rgba(127,29,29,0.95)",
          border: `1px solid ${toast.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"}`,
          color: toast.ok ? "#86efac" : "#fca5a5",
          fontSize: 14,
          fontWeight: 600,
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          maxWidth: 340,
        }}>
          {toast.msg}
        </div>
      )}

      {/* ヘッダー */}
      <header style={{ marginBottom: 28 }}>
        <button
          onClick={() => navigate("/admin/knowledge")}
          style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 10, minHeight: 44, display: "flex", alignItems: "center" } as React.CSSProperties}
        >
          ← ナレッジ管理に戻る
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
          📚 書籍管理
        </h1>
        <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
          PDFをアップロードしてAIの営業トークを強化しましょう
        </p>
      </header>

      {/* Phase47 Stream B: 構造化ステータスバッジ */}
      {structStatus && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 20,
          padding: '12px 16px',
          borderRadius: 10,
          border: '1px solid rgba(99,102,241,0.2)',
          background: 'rgba(99,102,241,0.06)',
        }}>
          <span style={{ fontSize: 14, color: '#d1d5db' }}>
            📚 ナレッジ: 合計 <strong style={{ color: '#f9fafb' }}>{structStatus.total_docs}</strong>件
            &ensp;|&ensp;構造化済み: <strong style={{ color: '#4ade80' }}>{structStatus.structured_count}</strong>件
            &ensp;|&ensp;未構造化: <strong style={{ color: '#fbbf24' }}>{structStatus.unstructured_count}</strong>件
          </span>
          {isSuperAdmin && structStatus.unstructured_count > 0 && (
            <button
              onClick={() => void handleStructurizeTrigger()}
              disabled={structTriggering}
              style={{
                padding: '8px 18px',
                minHeight: 44,
                borderRadius: 8,
                border: '1px solid rgba(99,102,241,0.4)',
                background: structTriggering ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.15)',
                color: '#a5b4fc',
                fontSize: 14,
                fontWeight: 600,
                cursor: structTriggering ? 'not-allowed' : 'pointer',
                opacity: structTriggering ? 0.6 : 1,
              }}
            >
              {structTriggering ? '⏳ 実行中...' : '✨ 構造化を実行'}
            </button>
          )}
        </div>
      )}

      {/* Super Admin: テナントセレクタ */}
      {isSuperAdmin && (
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 13, color: "#9ca3af", marginBottom: 6 }}>テナント選択</label>
          <select
            value={selectedTenantId}
            onChange={(e) => setSelectedTenantId(e.target.value)}
            style={{
              width: "100%",
              maxWidth: 360,
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid #374151",
              background: "rgba(15,23,42,0.8)",
              color: "#e5e7eb",
              fontSize: 16,
              minHeight: 48,
            }}
          >
            <option value="">テナントを選択してください</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.slug ? ` (${t.slug})` : ""}</option>
            ))}
          </select>
        </div>
      )}

      {/* アップロードエリア */}
      <div style={{
        marginBottom: 28,
        padding: "24px 20px",
        borderRadius: 14,
        border: "1px solid #1f2937",
        background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
      }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#d1d5db", margin: "0 0 16px" }}>
          書籍をアップロード
        </h2>

        {/* ドロップゾーン */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${dragOver ? "#60a5fa" : "#374151"}`,
            borderRadius: 12,
            padding: "32px 20px",
            textAlign: "center",
            background: dragOver ? "rgba(59,130,246,0.06)" : "rgba(15,23,42,0.4)",
            transition: "all 0.15s",
            cursor: "default",
            marginBottom: 14,
          }}
        >
          {file ? (
            <div>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", marginBottom: 4 }}>{file.name}</div>
              <div style={{ fontSize: 13, color: "#6b7280" }}>{(file.size / 1024 / 1024).toFixed(2)} MB</div>
              <button
                onClick={() => { setFile(null); setFileError(null); }}
                style={{
                  marginTop: 12,
                  padding: "6px 14px",
                  borderRadius: 8,
                  border: "1px solid #374151",
                  background: "transparent",
                  color: "#9ca3af",
                  fontSize: 13,
                  cursor: "pointer",
                  minHeight: 44,
                }}
              >
                取り消す
              </button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#d1d5db", marginBottom: 6 }}>
                PDFファイルをドラッグ&ドロップ
              </div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>または</div>
              <label style={{
                display: "inline-block",
                padding: "10px 22px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(99,102,241,0.5)",
                background: "rgba(99,102,241,0.12)",
                color: "#a5b4fc",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                lineHeight: "24px",
              }}>
                ファイルを選択
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={handleFileInput}
                  style={{ display: "none" }}
                />
              </label>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 10 }}>
                対応形式: PDF（50MBまで）
              </div>
            </div>
          )}
        </div>

        {/* ファイルエラー */}
        {fileError && (
          <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(127,29,29,0.3)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 14, marginBottom: 12 }}>
            {fileError}
          </div>
        )}

        {/* タイトル入力 */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 13, color: "#9ca3af", marginBottom: 6 }}>
            タイトル <span style={{ color: "#f87171" }}>*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => { setTitle(e.target.value); setTitleError(null); }}
            placeholder="書籍のタイトルを入力"
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: 10,
              border: `1px solid ${titleError ? "rgba(248,113,113,0.5)" : "#374151"}`,
              background: "rgba(15,23,42,0.8)",
              color: "#e5e7eb",
              fontSize: 16,
              minHeight: 48,
              boxSizing: "border-box",
            }}
          />
          {titleError && (
            <div style={{ fontSize: 13, color: "#f87171", marginTop: 6 }}>{titleError}</div>
          )}
        </div>

        {/* アップロードボタン */}
        <button
          onClick={() => { void handleUpload(); }}
          disabled={!file || uploading}
          style={{
            padding: "14px 28px",
            minHeight: 48,
            borderRadius: 12,
            border: "none",
            background: !file || uploading
              ? "rgba(99,102,241,0.3)"
              : "linear-gradient(135deg, #6366f1, #4f46e5)",
            color: !file || uploading ? "#6b7280" : "#fff",
            fontSize: 16,
            fontWeight: 700,
            cursor: !file || uploading ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: 10,
            opacity: !file || uploading ? 0.7 : 1,
          }}
        >
          {uploading ? (
            <>
              <span style={{
                display: "inline-block",
                width: 18,
                height: 18,
                border: "2px solid rgba(255,255,255,0.3)",
                borderTop: "2px solid #fff",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }} />
              アップロード中...
            </>
          ) : (
            <>📤 アップロード</>
          )}
        </button>
      </div>

      {/* 書籍一覧 */}
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#d1d5db", margin: "0 0 16px" }}>
          登録済み書籍
          {!booksLoading && books.length > 0 && (
            <span style={{ fontSize: 13, fontWeight: 400, color: "#6b7280", marginLeft: 10 }}>
              {books.length}件
            </span>
          )}
        </h2>

        {booksLoading ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "#6b7280" }}>
            <span style={{ fontSize: 28, display: "block", marginBottom: 8 }}>⏳</span>
            読み込み中...
          </div>
        ) : books.length === 0 ? (
          <div style={{
            padding: "48px 20px",
            textAlign: "center",
            borderRadius: 14,
            border: "1px dashed #374151",
            background: "rgba(15,23,42,0.4)",
          }}>
            <span style={{ fontSize: 40, display: "block", marginBottom: 12 }}>📚</span>
            <p style={{ fontSize: 16, fontWeight: 600, color: "#d1d5db", margin: "0 0 8px" }}>
              まだ書籍が登録されていません
            </p>
            <p style={{ fontSize: 14, color: "#6b7280", margin: 0 }}>
              上のエリアからPDFをアップロードしてAIの営業トークを強化しましょう
            </p>
          </div>
        ) : isMobile ? (
          // ─── モバイル: カード表示 ──────────────────────────────────────
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {books.map((book) => (
              <div
                key={book.id}
                style={{
                  padding: "16px 18px",
                  borderRadius: 14,
                  border: "1px solid #1f2937",
                  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                }}
              >
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", marginBottom: 4 }}>
                    {book.title}
                  </div>
                  {book.original_filename && book.original_filename !== book.title && (
                    <div style={{ fontSize: 12, color: "#6b7280" }}>{book.original_filename}</div>
                  )}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                  <StatusBadge status={book.status} errorMessage={book.error_message} />
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 12 }}>
                  {book.page_count != null && <span>📄 {book.page_count}ページ</span>}
                  {book.chunk_count != null && <span>📊 {book.chunk_count}チャンク</span>}
                  <span>🗓 {formatDate(book.created_at)}</span>
                </div>
                <ActionButtons
                  book={book}
                  processingId={processingId}
                  deletingId={deletingId}
                  onProcess={handleProcess}
                  onDelete={handleDelete}
                />
              </div>
            ))}
          </div>
        ) : (
          // ─── デスクトップ: テーブル表示 ───────────────────────────────
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 4px" }}>
              <thead>
                <tr>
                  {["タイトル", "ページ数", "チャンク数", "登録日", "状態", "操作"].map((h) => (
                    <th key={h} style={{
                      textAlign: "left",
                      padding: "10px 14px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#6b7280",
                      background: "rgba(15,23,42,0.8)",
                      borderBottom: "1px solid #1f2937",
                      whiteSpace: "nowrap",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {books.map((book) => (
                  <tr key={book.id}>
                    <td style={cellStyle}>
                      <div style={{ fontWeight: 600, color: "#f9fafb", fontSize: 14 }}>{book.title}</div>
                      {book.original_filename && book.original_filename !== book.title && (
                        <div style={{ fontSize: 11, color: "#6b7280" }}>{book.original_filename}</div>
                      )}
                    </td>
                    <td style={{ ...cellStyle, color: "#9ca3af", fontSize: 14 }}>
                      {book.page_count != null ? `${book.page_count}` : "-"}
                    </td>
                    <td style={{ ...cellStyle, color: "#9ca3af", fontSize: 14 }}>
                      {book.chunk_count != null ? `${book.chunk_count}` : "-"}
                    </td>
                    <td style={{ ...cellStyle, color: "#9ca3af", fontSize: 13, whiteSpace: "nowrap" }}>
                      {formatDate(book.created_at)}
                    </td>
                    <td style={cellStyle}>
                      <StatusBadge status={book.status} errorMessage={book.error_message} />
                    </td>
                    <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                      <ActionButtons
                        book={book}
                        processingId={processingId}
                        deletingId={deletingId}
                        onProcess={handleProcess}
                        onDelete={handleDelete}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── テーブルセルスタイル ─────────────────────────────────────────────────────

const cellStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid #1f2937",
  verticalAlign: "middle",
};

// ─── 操作ボタン群 ─────────────────────────────────────────────────────────────

function ActionButtons({
  book,
  processingId,
  deletingId,
  onProcess,
  onDelete,
}: {
  book: Book;
  processingId: number | null;
  deletingId: number | null;
  onProcess: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const isProcessing = processingId === book.id;
  const isDeleting = deletingId === book.id;

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {(book.status === "uploaded" || book.status === "error") && (
        <button
          onClick={() => onProcess(book.id)}
          disabled={isProcessing}
          style={{
            padding: "8px 14px",
            minHeight: 44,
            borderRadius: 8,
            border: "1px solid rgba(99,102,241,0.4)",
            background: isProcessing ? "rgba(99,102,241,0.05)" : "rgba(99,102,241,0.12)",
            color: "#a5b4fc",
            fontSize: 13,
            fontWeight: 600,
            cursor: isProcessing ? "not-allowed" : "pointer",
            opacity: isProcessing ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {isProcessing ? "処理中..." : book.status === "error" ? "🔄 再処理" : "▶ 処理開始"}
        </button>
      )}
      <button
        onClick={() => onDelete(book.id)}
        disabled={isDeleting}
        style={{
          padding: "8px 14px",
          minHeight: 44,
          borderRadius: 8,
          border: "1px solid rgba(239,68,68,0.3)",
          background: isDeleting ? "rgba(239,68,68,0.05)" : "transparent",
          color: "#f87171",
          fontSize: 13,
          fontWeight: 600,
          cursor: isDeleting ? "not-allowed" : "pointer",
          opacity: isDeleting ? 0.6 : 1,
          whiteSpace: "nowrap",
        }}
      >
        {isDeleting ? "削除中..." : "🗑 削除"}
      </button>
    </div>
  );
}
