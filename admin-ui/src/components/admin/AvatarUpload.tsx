import { useCallback, useMemo, useRef, useState } from "react";
import { API_BASE } from "../../lib/api";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; progress: number; fileName: string }
  | { status: "success"; fileName: string; avatarId?: string }
  | { status: "error"; message: string };

interface AvatarUploadProps {
  uploadEndpoint?: string;
  onUploaded?: (result: { avatarId?: string; fileName: string }) => void;
}

function getAccessToken(): string | null {
  const raw = localStorage.getItem("supabaseSession");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

function validateImage(file: File): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return "PNG・JPEG・WebPの画像を選んでください。";
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return "画像サイズが大きすぎます。5MB以下の画像を選んでください。";
  }
  return null;
}

export default function AvatarUpload({
  uploadEndpoint = "/admin/avatar/upload",
  onUploaded,
}: AvatarUploadProps) {
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const clearPreview = useCallback(() => {
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  }, []);

  const processFile = useCallback(
    async (file: File) => {
      const error = validateImage(file);
      if (error) {
        setState({ status: "error", message: error });
        return;
      }

      clearPreview();
      const token = getAccessToken();
      if (!token) {
        setState({
          status: "error",
          message: "ログインの有効期限が切れました。再度ログインしてください。",
        });
        return;
      }

      const localPreview = URL.createObjectURL(file);
      setPreviewUrl(localPreview);
      setState({ status: "uploading", progress: 0, fileName: file.name });

      try {
        const formData = new FormData();
        formData.append("avatar", file);

        const xhr = new XMLHttpRequest();
        const result = await new Promise<{ avatarId?: string }>((resolve, reject) => {
          xhr.upload.addEventListener("progress", (event) => {
            if (!event.lengthComputable) return;
            const pct = Math.round((event.loaded / event.total) * 100);
            setState({ status: "uploading", progress: pct, fileName: file.name });
          });

          xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const json = JSON.parse(xhr.responseText) as { avatarId?: string };
                resolve({ avatarId: json.avatarId });
              } catch {
                resolve({});
              }
              return;
            }
            if (xhr.status === 401 || xhr.status === 403) {
              reject(new Error("ログインの有効期限が切れました。再度ログインしてください。"));
              return;
            }
            reject(new Error("アップロードに失敗しました。時間をおいて再度お試しください。"));
          });

          xhr.addEventListener("error", () => {
            reject(new Error("通信が不安定です。接続を確認してもう一度お試しください。"));
          });

          xhr.open("POST", `${API_BASE}${uploadEndpoint}`);
          xhr.setRequestHeader("Authorization", `Bearer ${token}`);
          xhr.send(formData);
        });

        setState({ status: "success", fileName: file.name, avatarId: result.avatarId });
        onUploaded?.({ avatarId: result.avatarId, fileName: file.name });
      } catch (err: unknown) {
        setState({
          status: "error",
          message:
            err instanceof Error
              ? err.message
              : "少し問題が起きました。もう一度試してみてください 🙏",
        });
      }
    },
    [clearPreview, onUploaded, uploadEndpoint]
  );

  const statusText = useMemo(() => {
    if (state.status === "uploading") return `アップロード中... ${state.progress}%`;
    if (state.status === "success") return "アップロード完了！会話用アバターに反映されます。";
    if (state.status === "error") return state.message;
    return "会話に使う画像を選んでください（PNG/JPEG/WebP・5MBまで）";
  }, [state]);

  return (
    <section
      style={{
        borderRadius: 16,
        border: "1px solid #1f2937",
        background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <h3 style={{ margin: 0, color: "#f9fafb", fontSize: 18 }}>アバター画像を設定</h3>

      <p style={{ margin: 0, color: "#9ca3af", fontSize: 14 }}>
        お客様との会話で表示する画像です。明るく見やすい写真がおすすめです。
      </p>

      <div
        style={{
          borderRadius: 12,
          border: "1px dashed #374151",
          background: "rgba(2,6,23,0.45)",
          minHeight: 160,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="アバタープレビュー"
            style={{ width: "100%", height: 220, objectFit: "cover" }}
          />
        ) : (
          <span style={{ fontSize: 14, color: "#6b7280" }}>画像プレビュー</span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void processFile(file);
        }}
        style={{ display: "none" }}
      />

      <button
        onClick={() => inputRef.current?.click()}
        disabled={state.status === "uploading"}
        style={{
          minHeight: 56,
          minWidth: 44,
          borderRadius: 12,
          border: "none",
          background:
            state.status === "uploading"
              ? "rgba(55,65,81,0.8)"
              : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: state.status === "uploading" ? "#9ca3af" : "#022c22",
          fontSize: 16,
          fontWeight: 700,
          cursor: state.status === "uploading" ? "not-allowed" : "pointer",
          padding: "14px 20px",
        }}
      >
        {state.status === "uploading" ? "アップロード中..." : "画像を選ぶ"}
      </button>

      <div
        style={{
          minHeight: 44,
          borderRadius: 10,
          border:
            state.status === "error"
              ? "1px solid rgba(248,113,113,0.3)"
              : "1px solid rgba(31,41,55,0.8)",
          background:
            state.status === "error"
              ? "rgba(127,29,29,0.35)"
              : state.status === "success"
                ? "rgba(21,128,61,0.25)"
                : "rgba(2,6,23,0.35)",
          color:
            state.status === "error"
              ? "#fca5a5"
              : state.status === "success"
                ? "#86efac"
                : "#9ca3af",
          display: "flex",
          alignItems: "center",
          padding: "10px 12px",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {statusText}
      </div>
    </section>
  );
}
