import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import { API_BASE } from "../../lib/api";
import { useAuth } from "../../auth/useAuth";
import { useLang } from "../../i18n/LangContext";
import { fetchWithAuth, getAccessToken } from "./shared";
import {
  classifyUploadStatus,
  uploadBookPdfWithProgress,
  validateBookPdfFile,
} from "../../lib/bookPdfUpload";
import BookChunksPanel from "../../pages/admin/knowledge/BookChunksPanel";

// ─── PDFアップロードタブ ──────────────────────────────────────────────────────

interface BookUpload {
  id: number;
  tenant_id: string;
  title: string;
  original_filename: string;
  status: "uploaded" | "processing" | "chunked" | "embedded" | "failed";
  page_count: number | null;
  chunk_count: number | null;
  file_size_bytes: number | null;
  created_at: string;
}

type TFunc = ReturnType<typeof useLang>["t"];

function bookStatusLabel(status: string, t: TFunc): string {
  const map: Record<string, string> = {
    uploaded: t("knowledge.pdf_book_status_uploaded"),
    processing: t("knowledge.pdf_book_status_processing"),
    chunked: t("knowledge.pdf_book_status_chunked"),
    embedded: t("knowledge.pdf_book_status_embedded"),
    failed: t("knowledge.pdf_book_status_failed"),
  };
  return map[status] ?? status;
}

const STATUS_COLOR: Record<string, string> = {
  uploaded: "#9ca3af",
  processing: "#60a5fa",
  chunked: "#a78bfa",
  embedded: "#4ade80",
  failed: "#f87171",
};

// ─── BookUploadsSection: グローバルナレッジページ用書籍一覧 ───────────────────

export function BookUploadsSection({ tenantId }: { tenantId: string }) {
  const { t } = useLang();
  const [books, setBooks] = useState<BookUpload[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [selectedBook, setSelectedBook] = useState<BookUpload | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const loadBooks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/book-pdf?tenant=${encodeURIComponent(tenantId)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { books?: BookUpload[] };
      setBooks(data.books ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void loadBooks(); }, [loadBooks]);

  const handleProcess = async (bookId: number) => {
    setProcessing(bookId);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/knowledge/book-pdf/${bookId}/process`,
        { method: "POST" }
      );
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        showToast(err.error ?? t("knowledge.pdf_process_start_failed"), false);
        return;
      }
      showToast(t("knowledge.pdf_process_started"), true);
      setTimeout(() => { void loadBooks(); }, 2000);
    } catch {
      showToast(t("knowledge.pdf_process_start_failed"), false);
    } finally {
      setProcessing(null);
    }
  };

  const statusBadgeStyle = (status: string): CSSProperties => {
    const colors: Record<string, { bg: string; color: string }> = {
      uploaded:   { bg: "rgba(156,163,175,0.15)", color: "#9ca3af" },
      processing: { bg: "rgba(251,191,36,0.15)",  color: "#fbbf24" },
      chunked:    { bg: "rgba(167,139,250,0.15)", color: "#a78bfa" },
      embedded:   { bg: "rgba(74,222,128,0.15)",  color: "#4ade80" },
      failed:     { bg: "rgba(248,113,113,0.15)", color: "#f87171" },
    };
    const c = colors[status] ?? colors["uploaded"]!;
    return {
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      background: c.bg,
      color: c.color,
    };
  };

  return (
    <div style={{ marginTop: 32 }}>
      {toast && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 9999,
          padding: "12px 20px", borderRadius: 10, fontSize: 14, fontWeight: 600,
          background: toast.ok ? "rgba(5,46,22,0.95)" : "rgba(127,29,29,0.95)",
          border: `1px solid ${toast.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"}`,
          color: toast.ok ? "#86efac" : "#fca5a5",
        }}>
          {toast.msg}
        </div>
      )}

      {selectedBook && (
        <BookChunksPanel
          bookId={selectedBook.id}
          bookTitle={selectedBook.title}
          bookStatus={selectedBook.status}
          tenantId={tenantId}
          onClose={() => setSelectedBook(null)}
          onChunkDeleted={() => { void loadBooks(); }}
        />
      )}

      <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        {t("knowledge.pdf_uploaded_books_title")}
      </h2>

      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>{t("knowledge.pdf_loading")}</div>
      ) : books.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", borderRadius: 12, border: "1px dashed #374151", color: "#6b7280", fontSize: 14 }}>
          {t("knowledge.pdf_no_books")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {books.map((book) => (
            <div key={book.id} style={{
              padding: "14px 16px", borderRadius: 12,
              border: "1px solid #1f2937",
              background: "rgba(15,23,42,0.6)",
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb", marginBottom: 4, wordBreak: "break-word" }}>
                  {book.title}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <span style={statusBadgeStyle(book.status)}>
                    {bookStatusLabel(book.status, t)}
                  </span>
                  {book.chunk_count != null && (
                    <span>{book.chunk_count}件の分割テキスト</span>
                  )}
                  {book.page_count != null && (
                    <span>{book.page_count}ページ</span>
                  )}
                  <span>{new Date(book.created_at).toLocaleDateString("ja-JP")}</span>
                </div>
                {book.status === "failed" && (
                  <div style={{ fontSize: 12, color: "#f87171", marginTop: 4 }}>
                    {t("knowledge.pdf_book_error")}
                  </div>
                )}
                {book.status === "embedded" && (
                  <div style={{ fontSize: 12, color: "#4ade80", marginTop: 4 }}>
                    {t("knowledge.pdf_book_embedded_success", { n: book.chunk_count ?? 0 })}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                {(book.status === "chunked" || book.status === "embedded") && (
                  <button
                    onClick={() => setSelectedBook(book)}
                    style={{
                      padding: "8px 14px", minHeight: 44, borderRadius: 8,
                      border: "1px solid rgba(96,165,250,0.4)",
                      background: "rgba(96,165,250,0.08)",
                      color: "#60a5fa",
                      fontSize: 13, fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("knowledge.pdf_detail")}
                  </button>
                )}
                {(book.status === "uploaded" || book.status === "failed") && (
                  <button
                    onClick={() => { void handleProcess(book.id); }}
                    disabled={processing === book.id}
                    style={{
                      padding: "8px 14px", minHeight: 44, borderRadius: 8,
                      border: "none",
                      background: processing === book.id ? "#1f2937" : book.status === "failed" ? "#7f1d1d" : "#1d4ed8",
                      color: processing === book.id ? "#6b7280" : "#fff",
                      fontSize: 13, fontWeight: 600,
                      cursor: processing === book.id ? "not-allowed" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {processing === book.id
                      ? t("knowledge.pdf_processing_btn")
                      : book.status === "failed"
                      ? t("knowledge.pdf_reprocess_btn")
                      : t("knowledge.pdf_process_btn")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// B-2: 複数PDFアップロード用の型
type FileUploadStatus = "pending" | "uploading" | "processing" | "embedded" | "error";

interface QueuedFile {
  id: string; // ローカル管理用ユニークID
  file: File;
  title: string;
  status: FileUploadStatus;
  /** アップロード中の進捗率(0-100)。XHRのprogressイベントから更新 */
  progress?: number;
  uploadedBookId?: number;
  errorMsg?: string;
  isZip?: boolean;
  /** ZIPアップロード後の内訳（ZIPの場合のみ） */
  zipResults?: Array<{ fileName: string; bookId?: number; status: "ok" | "error"; error?: string }>;
}

const FILE_STATUS_ICON: Record<FileUploadStatus, string> = {
  pending: "⏳",
  uploading: "📤",
  processing: "⚙️",
  embedded: "✅",
  error: "❌",
};

function fileStatusLabel(status: FileUploadStatus, t: TFunc): string {
  const map: Record<FileUploadStatus, string> = {
    pending: t("knowledge.pdf_status_pending"),
    uploading: t("knowledge.pdf_status_uploading"),
    processing: t("knowledge.pdf_status_processing"),
    embedded: t("knowledge.pdf_status_embedded"),
    error: t("knowledge.pdf_status_error"),
  };
  return map[status];
}

/** XHRのstatusコードからユーザー向けエラーメッセージを分類する */
function classifyUploadError(status: number, t: TFunc, fallback?: string): string {
  switch (classifyUploadStatus(status)) {
    case "auth":
      return t("knowledge.pdf_error_auth");
    case "too_large":
      return t("knowledge.pdf_error_too_large");
    default:
      return fallback || t("knowledge.pdf_error_generic");
  }
}

export default function PdfUploadTab({ tenantId }: { tenantId: string }) {
  const { t } = useLang();
  const { isSuperAdmin } = useAuth();
  const [books, setBooks] = useState<BookUpload[]>([]);
  const [loadingBooks, setLoadingBooks] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [selectedBook, setSelectedBook] = useState<BookUpload | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragCounterRef = useRef(0);

  const listUrl = isSuperAdmin
    ? `${API_BASE}/v1/admin/knowledge/book-pdf?tenant=${encodeURIComponent(tenantId)}`
    : `${API_BASE}/v1/admin/knowledge/book-pdf`;

  const uploadUrl = isSuperAdmin
    ? `${API_BASE}/v1/admin/knowledge/book-pdf?tenant=${encodeURIComponent(tenantId)}`
    : `${API_BASE}/v1/admin/knowledge/book-pdf`;

  const loadBooks = useCallback(async () => {
    setLoadingBooks(true);
    try {
      const res = await fetchWithAuth(listUrl);
      if (!res.ok) return;
      const data = (await res.json()) as { books?: BookUpload[] };
      setBooks(data.books ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingBooks(false);
    }
  }, [listUrl]);

  useEffect(() => { void loadBooks(); }, [loadBooks]);

  // キュー内のuploadedBookIdと照合してstatusを更新するポーリング
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const res = await fetchWithAuth(listUrl);
          if (!res.ok) return;
          const data = (await res.json()) as { books?: BookUpload[] };
          const serverBooks = data.books ?? [];
          setBooks(serverBooks);
          setQueue((prev) => {
            const updated = prev.map((q) => {
              if (!q.uploadedBookId) return q;
              const serverBook = serverBooks.find((b) => b.id === q.uploadedBookId);
              if (!serverBook) return q;
              if (serverBook.status === "embedded") return { ...q, status: "embedded" as FileUploadStatus };
              if (serverBook.status === "failed") return { ...q, status: "error" as FileUploadStatus, errorMsg: t("knowledge.pdf_book_error") };
              return { ...q, status: "processing" as FileUploadStatus };
            });
            // 全件が embedded or error になったらポーリング停止
            const allDone = updated
              .filter((q) => q.uploadedBookId)
              .every((q) => q.status === "embedded" || q.status === "error");
            if (allDone && pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            return updated;
          });
        } catch {
          // ignore
        }
      })();
    }, 5000);
  }, [listUrl, t]);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const validateAndAddFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    const newEntries: QueuedFile[] = [];
    for (const f of arr) {
      const verdict = validateBookPdfFile(f);

      if (verdict.kind === "rejected") {
        const messageKey =
          verdict.reason === "type" ? "knowledge.pdf_error_type"
          : verdict.reason === "zip_size" ? "knowledge.pdf_error_zip_size"
          : "knowledge.pdf_error_size";
        showToast(`${f.name}: ${t(messageKey)}`, false);
        continue;
      }

      if (verdict.kind === "zip") {
        // ZIPはタイトル不要（サーバー側でファイル名から自動設定）
        newEntries.push({
          id: `${Date.now()}-${Math.random()}`,
          file: f,
          title: f.name.replace(/\.zip$/i, ""), // 表示用（実際はZIPを一括送信）
          status: "pending",
          isZip: true,
        });
        continue;
      }

      // デフォルトタイトル: ファイル名から拡張子除去（この面では利用者が上書きできる）
      newEntries.push({
        id: `${Date.now()}-${Math.random()}`,
        file: f,
        title: f.name.replace(/\.pdf$/i, ""),
        status: "pending",
      });
    }
    if (newEntries.length > 0) {
      setQueue((prev) => [...prev, ...newEntries]);
    }
  }, [t]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    validateAndAddFiles(e.dataTransfer.files);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDragOver(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndAddFiles(e.target.files);
      e.target.value = "";
    }
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const removeFromQueue = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  };

  const updateTitle = (id: string, title: string) => {
    setQueue((prev) => prev.map((q) => q.id === id ? { ...q, title } : q));
  };

  /** エラーになったアイテムを pending に戻して再送信可能にする */
  const retryItem = (id: string) => {
    setQueue((prev) =>
      prev.map((q) => (q.id === id ? { ...q, status: "pending", errorMsg: undefined, progress: undefined } : q))
    );
  };

  // 順次アップロード実行（XHRで進捗を取得）
  const handleUploadAll = async () => {
    const pendingItems = queue.filter((q) => q.status === "pending");
    if (pendingItems.length === 0) return;
    if (pendingItems.some((q) => !q.isZip && !q.title.trim())) {
      showToast(t("knowledge.pdf_error_missing_title"), false);
      return;
    }

    setRunning(true);
    let anyUploaded = false;
    const token = await getAccessToken();

    for (const item of pendingItems) {
      setQueue((prev) =>
        prev.map((q) => q.id === item.id ? { ...q, status: "uploading", progress: 0 } : q)
      );

      try {
        const form = new FormData();
        form.append("file", item.file);
        if (!item.isZip) {
          form.append("title", item.title.trim());
        }

        const { status, body, networkError } = await uploadBookPdfWithProgress(
          uploadUrl,
          form,
          token,
          (pct) => setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, progress: pct } : q)))
        );

        if (networkError) {
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id ? { ...q, status: "error", errorMsg: t("knowledge.pdf_error_network") } : q
            )
          );
          continue;
        }

        if (status < 200 || status >= 300) {
          const errBody = body as { error?: string } | null;
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? { ...q, status: "error", errorMsg: classifyUploadError(status, t, errBody?.error) }
                : q
            )
          );
          continue;
        }

        if (item.isZip) {
          // ZIPレスポンス: { message, total, results }
          const zipResp = body as {
            message?: string;
            total?: number;
            results?: Array<{ fileName: string; bookId?: number; status: "ok" | "error"; error?: string }>;
          };
          const successCount = (zipResp.results ?? []).filter((r) => r.status === "ok").length;
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? {
                    ...q,
                    status: successCount > 0 ? "processing" : "error",
                    errorMsg: successCount === 0 ? t("knowledge.pdf_error_zip_empty") : undefined,
                    zipResults: zipResp.results,
                  }
                : q
            )
          );
          if (successCount > 0) anyUploaded = true;
        } else {
          const created = body as { id?: number };
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? { ...q, status: "processing", uploadedBookId: created.id }
                : q
            )
          );
          anyUploaded = true;
        }
      } catch {
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? { ...q, status: "error", errorMsg: t("knowledge.pdf_error_generic") }
              : q
          )
        );
      }
    }

    setRunning(false);

    if (anyUploaded) {
      void loadBooks();
      startPolling();
    }
  };

  const pendingCount = queue.filter((q) => q.status === "pending").length;
  const hasQueue = queue.length > 0;

  return (
    <div>
      {/* トースト */}
      {toast && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 9999,
          padding: "12px 20px", borderRadius: 10, fontSize: 14, fontWeight: 600,
          background: toast.ok ? "rgba(5,46,22,0.95)" : "rgba(127,29,29,0.95)",
          border: `1px solid ${toast.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"}`,
          color: toast.ok ? "#86efac" : "#fca5a5",
        }}>
          {toast.msg}
        </div>
      )}

      {selectedBook && (
        <BookChunksPanel
          bookId={selectedBook.id}
          bookTitle={selectedBook.title}
          bookStatus={selectedBook.status}
          tenantId={tenantId}
          onClose={() => setSelectedBook(null)}
          onChunkDeleted={() => { void loadBooks(); }}
        />
      )}

      {/* ドラッグ＆ドロップゾーン（複数ファイル対応・キーボード操作対応） */}
      <div style={{ marginBottom: 20 }}>
        <div
          role="button"
          tabIndex={0}
          aria-label={t("knowledge.pdf_dropzone_label")}
          onDragEnter={handleDragEnter}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={openFilePicker}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openFilePicker();
            }
          }}
          style={{
            border: `2px dashed ${dragOver ? "#60a5fa" : "#374151"}`,
            borderRadius: 12, padding: "28px 20px", textAlign: "center",
            background: dragOver ? "rgba(96,165,250,0.06)" : "rgba(255,255,255,0.02)",
            cursor: "pointer", transition: "all 0.15s",
            outline: "none",
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.zip,application/pdf,application/zip"
            multiple
            style={{ display: "none" }}
            aria-hidden="true"
            tabIndex={-1}
            onChange={handleFileChange}
          />
          <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
          <div style={{ fontSize: 14, color: "#9ca3af" }}>
            {t("knowledge.pdf_dropzone_hint")}
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            {t("knowledge.pdf_dropzone_size_hint")}
          </div>
        </div>
      </div>

      {/* キュー表示 + タイトル入力 */}
      {hasQueue && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 8, fontWeight: 600 }}>
            {t("knowledge.pdf_queue_header", { n: queue.length })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {queue.map((item) => (
              <div
                key={item.id}
                style={{
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: `1px solid ${
                    item.status === "error" ? "rgba(248,113,113,0.3)"
                    : item.status === "embedded" ? "rgba(74,222,128,0.3)"
                    : "#1f2937"
                  }`,
                  background: item.status === "error"
                    ? "rgba(127,29,29,0.15)"
                    : item.status === "embedded"
                    ? "rgba(5,46,22,0.15)"
                    : "rgba(15,23,42,0.5)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: item.status === "pending" ? 8 : 4 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>
                    {FILE_STATUS_ICON[item.status]}
                  </span>
                  <span style={{ fontSize: 13, color: "#d1d5db", flex: 1, minWidth: 0, wordBreak: "break-word" }}>
                    {item.file.name}
                  </span>
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    color: item.status === "error" ? "#fca5a5"
                      : item.status === "embedded" ? "#4ade80"
                      : item.status === "processing" ? "#fbbf24"
                      : item.status === "uploading" ? "#60a5fa"
                      : "#9ca3af",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}>
                    {fileStatusLabel(item.status, t)}
                  </span>
                  {item.status === "pending" && !running && (
                    <button
                      onClick={() => removeFromQueue(item.id)}
                      aria-label="削除"
                      style={{
                        padding: "4px 8px", minHeight: 28,
                        borderRadius: 6, border: "1px solid #374151",
                        background: "transparent", color: "#6b7280",
                        fontSize: 12, cursor: "pointer", flexShrink: 0,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* アップロード進捗バー */}
                {item.status === "uploading" && (
                  <div style={{ marginTop: 6, marginBottom: 2 }}>
                    <div style={{ width: "100%", height: 5, borderRadius: 999, background: "#1f2937", overflow: "hidden" }}>
                      <div style={{
                        height: "100%", borderRadius: 999,
                        background: "linear-gradient(90deg, #3b82f6, #60a5fa)",
                        width: `${item.progress ?? 0}%`,
                        transition: "width 0.2s ease",
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{item.progress ?? 0}%</div>
                  </div>
                )}

                {/* ZIPの場合: 展開メッセージ表示 */}
                {item.isZip && item.status === "pending" && (
                  <div style={{ fontSize: 12, color: "#60a5fa", marginTop: 4 }}>
                    {t("knowledge.pdf_zip_hint")}
                  </div>
                )}

                {/* ZIP結果内訳 */}
                {item.isZip && item.zipResults && item.zipResults.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
                    {item.zipResults.map((r, i) => (
                      <div key={i} style={{ fontSize: 11, color: r.status === "ok" ? "#4ade80" : "#fca5a5", paddingLeft: 8 }}>
                        {r.status === "ok" ? "✓" : "✗"} {r.fileName}{r.error ? `: ${r.error}` : ""}
                      </div>
                    ))}
                  </div>
                )}

                {/* タイトル入力（pendingのPDFのみ） */}
                {item.status === "pending" && !item.isZip && (
                  <input
                    type="text"
                    value={item.title}
                    onChange={(e) => updateTitle(item.id, e.target.value)}
                    placeholder={t("knowledge.pdf_title_placeholder")}
                    disabled={running}
                    style={{
                      width: "100%", padding: "8px 12px",
                      borderRadius: 7, border: "1px solid #374151",
                      background: "rgba(255,255,255,0.05)",
                      color: "#f9fafb", fontSize: 13,
                      boxSizing: "border-box",
                    }}
                  />
                )}

                {item.status === "error" && item.errorMsg && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 12, color: "#fca5a5", flex: 1, minWidth: 0 }}>
                      {item.errorMsg}
                    </div>
                    <button
                      onClick={() => retryItem(item.id)}
                      style={{
                        padding: "4px 10px", minHeight: 28,
                        borderRadius: 999, border: "1px solid #374151",
                        background: "rgba(15,23,42,0.8)", color: "#e5e7eb",
                        fontSize: 11, cursor: "pointer", fontWeight: 500,
                        flexShrink: 0,
                      }}
                    >
                      {t("knowledge.pdf_retry")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* アップロードボタン */}
          {pendingCount > 0 && (
            <button
              onClick={() => { void handleUploadAll(); }}
              disabled={running}
              style={{
                marginTop: 12,
                width: "100%", minHeight: 48, borderRadius: 10,
                border: "none",
                background: running ? "#1f2937" : "#1d4ed8",
                color: running ? "#6b7280" : "#fff",
                fontSize: 15, fontWeight: 700,
                cursor: running ? "not-allowed" : "pointer",
              }}
            >
              {running
                ? t("knowledge.pdf_uploading_btn")
                : t("knowledge.pdf_upload_btn", { n: pendingCount })}
            </button>
          )}

          {/* キュークリアボタン（全件完了後） */}
          {!running && queue.every((q) => q.status === "embedded" || q.status === "error") && (
            <button
              onClick={() => setQueue([])}
              style={{
                marginTop: 8,
                width: "100%", minHeight: 44, borderRadius: 10,
                border: "1px solid #374151", background: "transparent",
                color: "#9ca3af", fontSize: 14, fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("knowledge.pdf_clear_list")}
            </button>
          )}
        </div>
      )}

      {/* 書籍一覧 */}
      {loadingBooks ? (
        <div style={{ color: "#6b7280", fontSize: 14 }}>{t("knowledge.pdf_loading")}</div>
      ) : books.length === 0 ? (
        <div style={{ color: "#6b7280", fontSize: 14 }}>{t("knowledge.pdf_no_books")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {books.map((book) => (
            <div key={book.id} style={{
              padding: "12px 16px", borderRadius: 10,
              border: "1px solid #1f2937", background: "rgba(255,255,255,0.02)",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb" }}>{book.title}</div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {book.original_filename}
                  {book.page_count != null && ` · ${book.page_count}ページ`}
                  {book.chunk_count != null && ` · ${book.chunk_count}件の分割テキスト`}
                  {book.file_size_bytes != null && ` · ${(book.file_size_bytes / 1024 / 1024).toFixed(1)}MB`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                {(book.status === "chunked" || book.status === "embedded") && (
                  <button
                    onClick={() => setSelectedBook(book)}
                    style={{
                      padding: "6px 12px", minHeight: 36, borderRadius: 8,
                      border: "1px solid rgba(96,165,250,0.4)",
                      background: "rgba(96,165,250,0.08)",
                      color: "#60a5fa",
                      fontSize: 12, fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("knowledge.pdf_detail")}
                  </button>
                )}
                <span style={{
                  padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                  background: "rgba(0,0,0,0.3)", color: STATUS_COLOR[book.status] ?? "#9ca3af",
                  border: `1px solid ${STATUS_COLOR[book.status] ?? "#374151"}22`,
                  whiteSpace: "nowrap",
                }}>
                  {bookStatusLabel(book.status, t)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
