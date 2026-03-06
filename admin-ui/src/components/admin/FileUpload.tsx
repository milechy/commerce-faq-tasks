import { useCallback, useRef, useState } from "react";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ACCEPTED_MIME = "application/pdf";

type UploadState =
  | { status: "idle" }
  | { status: "dragging" }
  | { status: "uploading"; fileName: string; progress: number }
  | { status: "success"; fileName: string }
  | { status: "error"; message: string };

interface FileUploadProps {
  onUploadSuccess?: (fileName: string) => void;
  /** アップロード成功時にレスポンスJSONを受け取るコールバック */
  onUploadResponse?: (data: unknown) => void;
  /** POST先エンドポイント。デフォルト /admin/knowledge/upload */
  uploadEndpoint?: string;
}

function validateFile(file: File): string | null {
  if (file.type !== ACCEPTED_MIME) {
    return "PDFファイルのみアップロードできます。他の形式には対応していません。";
  }
  if (file.size > MAX_FILE_SIZE) {
    return `ファイルサイズが大きすぎます（最大50MB）。\n現在のサイズ: ${(file.size / 1024 / 1024).toFixed(1)}MB`;
  }
  return null;
}

export default function FileUpload({
  onUploadSuccess,
  onUploadResponse,
  uploadEndpoint = "/admin/knowledge/upload",
}: FileUploadProps) {
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

      const processFile = useCallback(
    async (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setState({ status: "error", message: validationError });
        return;
      }

      setState({ status: "uploading", fileName: file.name, progress: 0 });

      try {
        const token = (() => {
          const raw = localStorage.getItem("supabaseSession");
          if (!raw) return null;
          try {
            return (JSON.parse(raw) as { access_token?: string })?.access_token ?? null;
          } catch {
            return null;
          }
        })();

        const formData = new FormData();
        formData.append("file", file);

        const xhr = new XMLHttpRequest();
        let uploadResponseData: unknown = null;

        await new Promise<void>((resolve, reject) => {
          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              setState({ status: "uploading", fileName: file.name, progress: pct });
            }
          });

          xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                uploadResponseData = JSON.parse(xhr.responseText);
              } catch {
                uploadResponseData = null;
              }
              resolve();
            } else if (xhr.status === 401 || xhr.status === 403) {
              reject(new Error("ログインの有効期限が切れました。再度ログインしてください。"));
            } else if (xhr.status === 413) {
              reject(new Error("ファイルが大きすぎます。50MB以下のPDFをお選びください。"));
            } else {
              reject(new Error("少し問題が起きました。もう一度試してみてください 🙏"));
            }
          });

          xhr.addEventListener("error", () => {
            reject(new Error("ネットワークエラーが発生しました。接続を確認してもう一度お試しください。"));
          });

          xhr.open("POST", `http://localhost:3100${uploadEndpoint}`);
          if (token) {
            xhr.setRequestHeader("Authorization", `Bearer ${token}`);
          }
          xhr.send(formData);
        });

        setState({ status: "success", fileName: file.name });
        onUploadSuccess?.(file.name);
        onUploadResponse?.(uploadResponseData);

        setTimeout(() => setState({ status: "idle" }), 4000);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "少し問題が起きました。もう一度試してみてください 🙏";
        setState({ status: "error", message });
      }
    },
    [uploadEndpoint, onUploadSuccess, onUploadResponse],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setState({ status: "idle" });

      const file = e.dataTransfer.files[0];
      if (!file) return;
      processFile(file);
    },
    [processFile],
  );

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    setState((prev) =>
      prev.status === "uploading" || prev.status === "success" ? prev : { status: "dragging" },
    );
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setState((prev) => (prev.status === "dragging" ? { status: "idle" } : prev));
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      processFile(file);
    },
    [processFile],
  );

  const handleClick = useCallback(() => {
    if (state.status === "uploading") return;
    inputRef.current?.click();
  }, [state.status]);

  const handleRetry = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  const isDragging = state.status === "dragging";
  const isUploading = state.status === "uploading";
  const isSuccess = state.status === "success";
  const isError = state.status === "error";
  const isIdle = state.status === "idle";

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="PDFファイルをアップロード。クリックまたはドラッグ&ドロップで選択"
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleClick();
        }}
        style={{
          border: `2px dashed ${
            isDragging
              ? "#22c55e"
              : isSuccess
                ? "#4ade80"
                : isError
                  ? "#f87171"
                  : "#374151"
          }`,
          borderRadius: 16,
          padding: "32px 24px",
          textAlign: "center",
          cursor: isUploading ? "default" : "pointer",
          background: isDragging
            ? "rgba(34,197,94,0.08)"
            : isSuccess
              ? "rgba(74,222,128,0.06)"
              : "rgba(15,23,42,0.6)",
          transition: "all 0.2s ease",
          outline: "none",
          minHeight: 180,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          onChange={handleInputChange}
          style={{ display: "none" }}
          aria-hidden="true"
        />

        {isSuccess && state.status === "success" && (
          <>
            <span style={{ fontSize: 40 }}>✅</span>
            <p style={{ fontSize: 17, fontWeight: 600, color: "#4ade80", margin: 0 }}>
              アップロード完了！
            </p>
            <p style={{ fontSize: 14, color: "#9ca3af", margin: 0 }}>
              「{state.fileName}」をAIが確認中です。約1分かかります。
            </p>
          </>
        )}

        {isUploading && state.status === "uploading" && (
          <>
            <span style={{ fontSize: 36 }}>📄</span>
            <p style={{ fontSize: 17, fontWeight: 600, color: "#e5e7eb", margin: 0 }}>
              AIが内容を確認中... 約1分かかります
            </p>
            <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>
              {state.fileName}
            </p>
            <div
              style={{
                width: "100%",
                maxWidth: 280,
                height: 6,
                borderRadius: 999,
                background: "#1f2937",
                overflow: "hidden",
                marginTop: 4,
              }}
            >
              <div
                style={{
                  height: "100%",
                  borderRadius: 999,
                  background: "linear-gradient(90deg, #22c55e, #4ade80)",
                  width: `${state.progress}%`,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>{state.progress}%</p>
          </>
        )}

        {isError && state.status === "error" && (
          <>
            <span style={{ fontSize: 36 }}>⚠️</span>
            <p
              style={{
                fontSize: 16,
                color: "#fca5a5",
                margin: 0,
                whiteSpace: "pre-wrap",
                lineHeight: 1.6,
              }}
            >
              {state.message}
            </p>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRetry();
              }}
              style={{
                marginTop: 8,
                padding: "12px 24px",
                minHeight: 44,
                borderRadius: 999,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb",
                fontSize: 15,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              もう一度試す
            </button>
          </>
        )}

        {(isIdle || isDragging) && (
          <>
            <span
              style={{
                fontSize: 40,
                transition: "transform 0.2s ease",
                transform: isDragging ? "scale(1.2)" : "scale(1)",
              }}
            >
              📁
            </span>
            <p style={{ fontSize: 17, fontWeight: 600, color: "#e5e7eb", margin: 0 }}>
              {isDragging
                ? "ここにドロップしてください"
                : "PDFをドラッグ&ドロップ、またはクリックして選択"}
            </p>
            <p style={{ fontSize: 14, color: "#6b7280", margin: 0 }}>
              PDF形式のみ対応 · 最大50MB
            </p>
          </>
        )}
      </div>
    </div>
  );
}
