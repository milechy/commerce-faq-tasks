import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import { API_BASE } from "../../lib/api";
import { useAuth } from "../../auth/useAuth";
import { fetchWithAuth } from "./shared";
import BookChunksPanel from "../../pages/admin/knowledge/BookChunksPanel";

// ─── PDFアップロードタブ ──────────────────────────────────────────────────────

const MAX_BOOK_PDF_SIZE = 10 * 1024 * 1024; // 10MB フロントエンド制限

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

const STATUS_LABEL: Record<string, string> = {
  uploaded: "アップロード済",
  processing: "処理中",
  chunked: "分割完了",
  embedded: "登録完了",
  failed: "失敗",
};
const STATUS_COLOR: Record<string, string> = {
  uploaded: "#9ca3af",
  processing: "#60a5fa",
  chunked: "#a78bfa",
  embedded: "#4ade80",
  failed: "#f87171",
};

// ─── BookUploadsSection: グローバルナレッジページ用書籍一覧 ───────────────────

export function BookUploadsSection({ tenantId }: { tenantId: string }) {
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
        showToast(err.error ?? "処理の開始に失敗しました", false);
        return;
      }
      showToast("処理を開始しました", true);
      setTimeout(() => { void loadBooks(); }, 2000);
    } catch {
      showToast("処理の開始に失敗しました", false);
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
        📚 アップロード済み書籍
      </h2>

      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>読み込み中...</div>
      ) : books.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", borderRadius: 12, border: "1px dashed #374151", color: "#6b7280", fontSize: 14 }}>
          書籍PDFがありません
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
                    {STATUS_LABEL[book.status] ?? book.status}
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
                    エラーが発生しました
                  </div>
                )}
                {book.status === "embedded" && (
                  <div style={{ fontSize: 12, color: "#4ade80", marginTop: 4 }}>
                    ✅ {book.chunk_count ?? 0}件の分割テキスト登録完了
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
                    詳細
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
                    {processing === book.id ? "処理中..." : book.status === "failed" ? "再処理" : "処理開始"}
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

const FILE_STATUS_LABEL: Record<FileUploadStatus, string> = {
  pending: "待機中",
  uploading: "アップロード中",
  processing: "処理中",
  embedded: "完了",
  error: "エラー",
};

export default function PdfUploadTab({ tenantId }: { tenantId: string }) {
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
              if (serverBook.status === "failed") return { ...q, status: "error" as FileUploadStatus, errorMsg: "処理に失敗しました" };
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
  }, [listUrl]);

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

  const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip"]);
  const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB

  const validateAndAddFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    const newEntries: QueuedFile[] = [];
    for (const f of arr) {
      const isZip = ZIP_TYPES.has(f.type) || f.name.toLowerCase().endsWith(".zip");
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");

      if (!isPdf && !isZip) {
        showToast(`${f.name}: PDFまたはZIPファイルを選択してください`, false);
        continue;
      }

      if (isZip) {
        if (f.size > MAX_ZIP_SIZE) {
          showToast(`${f.name}: ファイルが大きすぎます。50MB以下のZIPファイルを選択してください。`, false);
          continue;
        }
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

      // PDF
      if (f.size > MAX_BOOK_PDF_SIZE) {
        showToast(`${f.name}: ファイルサイズが10MBを超えています`, false);
        continue;
      }
      // デフォルトタイトル: ファイル名から拡張子除去
      const defaultTitle = f.name.replace(/\.pdf$/i, "");
      newEntries.push({
        id: `${Date.now()}-${Math.random()}`,
        file: f,
        title: defaultTitle,
        status: "pending",
      });
    }
    if (newEntries.length > 0) {
      setQueue((prev) => [...prev, ...newEntries]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    validateAndAddFiles(e.dataTransfer.files);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndAddFiles(e.target.files);
      e.target.value = "";
    }
  };

  const removeFromQueue = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  };

  const updateTitle = (id: string, title: string) => {
    setQueue((prev) => prev.map((q) => q.id === id ? { ...q, title } : q));
  };

  // 順次アップロード実行
  const handleUploadAll = async () => {
    const pendingItems = queue.filter((q) => q.status === "pending");
    if (pendingItems.length === 0) return;
    if (pendingItems.some((q) => !q.isZip && !q.title.trim())) {
      showToast("全PDFファイルにタイトルを入力してください", false);
      return;
    }

    setRunning(true);
    let anyUploaded = false;

    for (const item of pendingItems) {
      // statusを「uploading」に更新
      setQueue((prev) =>
        prev.map((q) => q.id === item.id ? { ...q, status: "uploading" } : q)
      );

      try {
        const form = new FormData();
        form.append("file", item.file);
        if (!item.isZip) {
          form.append("title", item.title.trim());
        }
        const res = await fetchWithAuth(uploadUrl, { method: "POST", body: form });

        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? { ...q, status: "error", errorMsg: err.error ?? "アップロードに失敗しました" }
                : q
            )
          );
          continue;
        }

        if (item.isZip) {
          // ZIPレスポンス: { message, total, results }
          const zipResp = (await res.json()) as {
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
                    errorMsg: successCount === 0 ? "ZIPのPDFがアップロードできませんでした" : undefined,
                    zipResults: zipResp.results,
                  }
                : q
            )
          );
          if (successCount > 0) anyUploaded = true;
        } else {
          const created = (await res.json()) as { id?: number };
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
              ? { ...q, status: "error", errorMsg: "アップロードに失敗しました" }
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

      {/* ドラッグ＆ドロップゾーン（複数ファイル対応） */}
      <div style={{ marginBottom: 20 }}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${dragOver ? "#60a5fa" : "#374151"}`,
            borderRadius: 12, padding: "28px 20px", textAlign: "center",
            background: dragOver ? "rgba(96,165,250,0.06)" : "rgba(255,255,255,0.02)",
            cursor: "pointer", transition: "all 0.15s",
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.zip,application/pdf,application/zip"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
          <div style={{ fontSize: 14, color: "#9ca3af" }}>
            PDFまたはZIPをここにドラッグ＆ドロップ（複数可）
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            またはクリックして選択（PDF: 各10MB以内、ZIP: 50MB以内・最大20件）
          </div>
        </div>
      </div>

      {/* キュー表示 + タイトル入力 */}
      {hasQueue && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 8, fontWeight: 600 }}>
            アップロード予定のファイル（{queue.length}件）
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
                    {FILE_STATUS_LABEL[item.status]}
                  </span>
                  {item.status === "pending" && !running && (
                    <button
                      onClick={() => removeFromQueue(item.id)}
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

                {/* ZIPの場合: 展開メッセージ表示 */}
                {item.isZip && item.status === "pending" && (
                  <div style={{ fontSize: 12, color: "#60a5fa", marginTop: 4 }}>
                    ZIPファイル内のPDFを自動展開してアップロードします（最大20件）
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
                    placeholder="書籍タイトルを入力"
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
                  <div style={{ fontSize: 12, color: "#fca5a5", marginTop: 4 }}>
                    {item.errorMsg}
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
                ? "アップロード中..."
                : `📤 ${pendingCount}件をアップロード`}
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
              リストをクリア
            </button>
          )}
        </div>
      )}

      {/* 書籍一覧 */}
      {loadingBooks ? (
        <div style={{ color: "#6b7280", fontSize: 14 }}>読み込み中...</div>
      ) : books.length === 0 ? (
        <div style={{ color: "#6b7280", fontSize: 14 }}>書籍がまだ登録されていません</div>
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
                    詳細
                  </button>
                )}
                <span style={{
                  padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                  background: "rgba(0,0,0,0.3)", color: STATUS_COLOR[book.status] ?? "#9ca3af",
                  border: `1px solid ${STATUS_COLOR[book.status] ?? "#374151"}22`,
                  whiteSpace: "nowrap",
                }}>
                  {STATUS_LABEL[book.status] ?? book.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
