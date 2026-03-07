import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import FileUpload from "../../../components/admin/FileUpload";
import { API_BASE } from "../../../lib/api";

interface BookMetadata {
  id: string;
  title: string;
  author: string;
  totalPages: number;
  totalChunks: number;
  uploadedAt: number;
}

type DeleteState = "idle" | "confirming" | "deleting" | "success" | "error";

interface OcrJobStatus {
  status: "processing" | "done" | "failed";
  pages?: number;
  chunks?: number;
  error?: string;
}

interface DeleteTarget {
  id: string;
  title: string;
  state: DeleteState;
  error?: string;
}

function getAccessToken(): string | null {
  const raw = localStorage.getItem("supabaseSession");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { access_token?: string })?.access_token ?? null;
  } catch {
    localStorage.removeItem("supabaseSession");
    return null;
  }
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function KnowledgePage() {
  const navigate = useNavigate();
  const [books, setBooks] = useState<BookMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<OcrJobStatus | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBooks = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      navigate("/login", { replace: true });
      return;
    }

    try {
      setLoading(true);
      setFetchError(null);

      const res = await fetch(`${API_BASE}/admin/knowledge?tenantId=demo`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("supabaseSession");
        navigate("/login", { replace: true });
        return;
      }

      if (!res.ok) {
        throw new Error("少し問題が起きました。もう一度試してみてください 🙏");
      }

      const data = (await res.json()) as { books?: BookMetadata[] };
      setBooks(data.books ?? []);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "少し問題が起きました。もう一度試してみてください 🙏";
      setFetchError(message);
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    fetchBooks();
  }, [fetchBooks]);

  // ジョブステータスのポーリング
  useEffect(() => {
    if (!currentJobId) return;

    const pollOnce = async () => {
      const token = getAccessToken();
      if (!token) return;

      try {
        const res = await fetch(
          `${API_BASE}/v1/admin/knowledge/jobs/${currentJobId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return;

        const data = (await res.json()) as OcrJobStatus;
        setJobStatus(data);

        if (data.status === "done" || data.status === "failed") {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          setCurrentJobId(null);
          if (data.status === "done") {
            fetchBooks();
          }
        }
      } catch {
        // ポーリング失敗は無視
      }
    };

    void pollOnce();
    pollingRef.current = setInterval(() => void pollOnce(), 10_000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [currentJobId, fetchBooks]);

  const handleUploadSuccess = useCallback(
    (fileName: string) => {
      setUploadSuccess(fileName);
      setTimeout(() => setUploadSuccess(null), 5000);
    },
    [],
  );

  const handleUploadResponse = useCallback((data: unknown) => {
    const parsed = data as { jobId?: string } | null;
    if (parsed?.jobId) {
      setJobStatus({ status: "processing" });
      setCurrentJobId(parsed.jobId);
    }
  }, []);

  const handleDeleteClick = useCallback((book: BookMetadata) => {
    setDeleteTarget({ id: book.id, title: book.title, state: "confirming" });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const token = getAccessToken();
    if (!token) {
      navigate("/login", { replace: true });
      return;
    }

    setDeleteTarget((prev) => (prev ? { ...prev, state: "deleting" } : null));

    try {
      const res = await fetch(
        `${API_BASE}/admin/knowledge/${encodeURIComponent(deleteTarget.id)}?tenantId=demo`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("supabaseSession");
        navigate("/login", { replace: true });
        return;
      }

      if (!res.ok) {
        throw new Error("少し問題が起きました。もう一度試してみてください 🙏");
      }

      setDeleteTarget((prev) => (prev ? { ...prev, state: "success" } : null));
      setBooks((prev) => prev.filter((b) => b.id !== deleteTarget.id));

      setTimeout(() => setDeleteTarget(null), 2000);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "少し問題が起きました。もう一度試してみてください 🙏";
      setDeleteTarget((prev) => (prev ? { ...prev, state: "error", error: message } : null));
    }
  }, [deleteTarget, navigate]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 32,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 0",
              border: "none",
              background: "none",
              color: "#9ca3af",
              fontSize: 13,
              cursor: "pointer",
              marginBottom: 8,
            }}
          >
            ← ダッシュボードに戻る
          </button>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            AIナレッジ管理
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            AIが参照するPDF資料を登録・管理します
          </p>
        </div>
      </header>

      {uploadSuccess && (
        <div
          style={{
            marginBottom: 20,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(5,46,22,0.6)",
            border: "1px solid rgba(74,222,128,0.3)",
            color: "#86efac",
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          ✅ 「{uploadSuccess}」を登録しました！AIが内容の確認を開始しました。
        </div>
      )}

      {fetchError && (
        <div
          style={{
            marginBottom: 20,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 15,
          }}
        >
          {fetchError}
        </div>
      )}

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", marginBottom: 12 }}>
          新しい資料を追加する
        </h2>
        <FileUpload
          uploadEndpoint="/v1/admin/knowledge/pdf"
          onUploadSuccess={handleUploadSuccess}
          onUploadResponse={handleUploadResponse}
        />
        {jobStatus && (
          <div
            style={{
              marginTop: 12,
              padding: "12px 16px",
              borderRadius: 10,
              border: `1px solid ${
                jobStatus.status === "done"
                  ? "rgba(74,222,128,0.3)"
                  : jobStatus.status === "failed"
                    ? "rgba(248,113,113,0.3)"
                    : "rgba(96,165,250,0.3)"
              }`,
              background:
                jobStatus.status === "done"
                  ? "rgba(5,46,22,0.5)"
                  : jobStatus.status === "failed"
                    ? "rgba(127,29,29,0.4)"
                    : "rgba(23,37,84,0.5)",
              fontSize: 14,
              color:
                jobStatus.status === "done"
                  ? "#86efac"
                  : jobStatus.status === "failed"
                    ? "#fca5a5"
                    : "#93c5fd",
            }}
          >
            {jobStatus.status === "processing" && (
              <>⏳ AIが書籍を読み込み中です... しばらくお待ちください</>
            )}
            {jobStatus.status === "done" && (
              <>
                ✅ OCR完了！ {jobStatus.pages}ページ /{" "}
                {jobStatus.chunks}チャンクをAIナレッジに追加しました
              </>
            )}
            {jobStatus.status === "failed" && (
              <>⚠️ OCR処理に失敗しました。{jobStatus.error ?? "しばらく経ってから再試行してください。"}</>
            )}
          </div>
        )}
        <p
          style={{
            marginTop: 8,
            fontSize: 13,
            color: "#6b7280",
            lineHeight: 1.6,
          }}
        >
          アップロードされたPDFはサーバーで安全に保護されます。
          AIが内容を読み込むまで約1分かかります。
        </p>
      </section>

      <section>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", margin: 0 }}>
            登録済み資料（{books.length}件）
          </h2>
          <button
            onClick={fetchBooks}
            disabled={loading}
            style={{
              padding: "6px 12px",
              minHeight: 32,
              borderRadius: 999,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
              fontSize: 13,
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "読み込み中..." : "🔄 更新"}
          </button>
        </div>

        {loading && books.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "#6b7280",
              fontSize: 14,
            }}
          >
            <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
            読み込んでいます...
          </div>
        ) : books.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: "center",
              borderRadius: 14,
              border: "1px dashed #374151",
              background: "rgba(15,23,42,0.4)",
            }}
          >
            <span style={{ display: "block", fontSize: 40, marginBottom: 12 }}>📭</span>
            <p style={{ fontSize: 16, fontWeight: 600, color: "#d1d5db", margin: 0 }}>
              まだ資料が登録されていません
            </p>
            <p style={{ fontSize: 13, color: "#6b7280", marginTop: 6, marginBottom: 0 }}>
              上のエリアにPDFをドラッグ&ドロップしてください
            </p>
          </div>
        ) : (
          <div
            style={{
              borderRadius: 14,
              border: "1px solid #1f2937",
              background:
                "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
              overflow: "hidden",
            }}
          >
            {books.map((book, index) => (
              <div
                key={book.id}
                style={{
                  padding: "16px 18px",
                  borderBottom:
                    index === books.length - 1 ? "none" : "1px solid #111827",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 14,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: 28,
                    flexShrink: 0,
                    lineHeight: 1,
                    marginTop: 2,
                  }}
                >
                  📄
                </span>

                <div style={{ flex: 1, minWidth: 160 }}>
                  <p
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: "#f9fafb",
                      margin: 0,
                      lineHeight: 1.4,
                    }}
                  >
                    {book.title || "（タイトル未設定）"}
                  </p>
                  {book.author && (
                    <p style={{ fontSize: 13, color: "#9ca3af", margin: "3px 0 0" }}>
                      著者: {book.author}
                    </p>
                  )}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "4px 12px",
                      marginTop: 6,
                    }}
                  >
                    {book.totalPages > 0 && (
                      <span style={{ fontSize: 12, color: "#6b7280" }}>
                        {book.totalPages}ページ
                      </span>
                    )}
                    {book.totalChunks > 0 && (
                      <span style={{ fontSize: 12, color: "#6b7280" }}>
                        AIが読んだ箇所: {book.totalChunks}
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: "#6b7280" }}>
                      登録日: {formatDate(book.uploadedAt)}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => handleDeleteClick(book)}
                  style={{
                    padding: "10px 16px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid #7f1d1d",
                    background: "rgba(127,29,29,0.2)",
                    color: "#fca5a5",
                    fontSize: 14,
                    cursor: "pointer",
                    fontWeight: 500,
                    flexShrink: 0,
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(127,29,29,0.4)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(127,29,29,0.2)";
                  }}
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {deleteTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && deleteTarget.state !== "deleting")
              handleDeleteCancel();
          }}
        >
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #1f2937",
              borderRadius: 16,
              padding: "28px 24px",
              maxWidth: 420,
              width: "100%",
              boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
            }}
          >
            {deleteTarget.state === "success" ? (
              <div style={{ textAlign: "center" }}>
                <span style={{ fontSize: 48, display: "block", marginBottom: 12 }}>✅</span>
                <p style={{ fontSize: 17, fontWeight: 600, color: "#4ade80", margin: 0 }}>
                  削除しました
                </p>
                <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 8, marginBottom: 0 }}>
                  「{deleteTarget.title}」を削除しました。
                </p>
              </div>
            ) : (
              <>
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: "#f9fafb",
                    margin: "0 0 8px",
                  }}
                >
                  本当に削除しますか？
                </h3>
                <p style={{ fontSize: 15, color: "#d1d5db", margin: "0 0 6px" }}>
                  「{deleteTarget.title}」
                </p>
                <p
                  style={{
                    fontSize: 13,
                    color: "#9ca3af",
                    margin: "0 0 20px",
                    lineHeight: 1.6,
                  }}
                >
                  削除するとAIがこの資料を参照できなくなります。
                  この操作は取り消せません。
                </p>

                {deleteTarget.state === "error" && deleteTarget.error && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: "10px 14px",
                      borderRadius: 8,
                      background: "rgba(127,29,29,0.4)",
                      color: "#fca5a5",
                      fontSize: 14,
                    }}
                  >
                    {deleteTarget.error}
                  </div>
                )}

                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={handleDeleteCancel}
                    disabled={deleteTarget.state === "deleting"}
                    style={{
                      flex: 1,
                      padding: "14px",
                      minHeight: 56,
                      borderRadius: 10,
                      border: "1px solid #374151",
                      background: "transparent",
                      color: "#e5e7eb",
                      fontSize: 15,
                      fontWeight: 600,
                      cursor:
                        deleteTarget.state === "deleting" ? "not-allowed" : "pointer",
                    }}
                  >
                    やめる
                  </button>
                  <button
                    onClick={handleDeleteConfirm}
                    disabled={deleteTarget.state === "deleting"}
                    style={{
                      flex: 1,
                      padding: "14px",
                      minHeight: 56,
                      borderRadius: 10,
                      border: "none",
                      background:
                        deleteTarget.state === "deleting"
                          ? "rgba(127,29,29,0.5)"
                          : "linear-gradient(135deg, #991b1b, #dc2626)",
                      color: "#fee2e2",
                      fontSize: 15,
                      fontWeight: 700,
                      cursor:
                        deleteTarget.state === "deleting" ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                    }}
                  >
                    {deleteTarget.state === "deleting" ? (
                      <>削除中...</>
                    ) : (
                      <>削除する</>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
