// admin-ui/src/pages/admin/avatar/StudioVoiceCloneSection.tsx
// FishAudio Phase C-1: 音声クローン作成フォーム
// POST /v1/admin/avatar/configs/:id/voice-clone（multipart: name + audio）

import { useRef, useState } from "react";
import { useLang } from "../../../i18n/LangContext";
import { API_BASE } from "../../../lib/api";
// authFetch は Content-Type: application/json を強制するため multipart 不可。
// PdfUploadTab と同じ fetchWithAuth（Content-Type 未設定 = boundary 自動付与）を使う。
import { fetchWithAuth } from "../../../components/knowledge/shared";
import { SECTION_STYLE, LABEL_STYLE, INPUT_STYLE, BTN_PRIMARY } from "./types";

// バックエンド（src/api/admin/avatar/routes.ts voice-clone）と二重のフロント制限
const MAX_VOICE_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_VOICE_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/ogg",
];

const JA_TEXT_RE = /[぀-ヿ一-鿿]/;

export function StudioVoiceCloneSection({
  configId,
  currentVoiceId,
  isDefault,
  onCloneSuccess,
}: {
  configId: string;
  currentVoiceId: string | null;
  isDefault: boolean;
  onCloneSuccess: (voiceId: string) => void;
}) {
  const { lang } = useLang();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const trimmedName = cloneName.trim();
  const canSubmit =
    !isDefault &&
    !uploading &&
    file !== null &&
    trimmedName.length >= 1 &&
    trimmedName.length <= 100;

  const fallbackError = lang === "ja"
    ? "音声クローンの作成に失敗しました。時間をおいて再度お試しください"
    : "Voice clone creation failed. Please try again later.";

  const validateAndSetFile = (f: File) => {
    setErrorMsg(null);
    if (!ALLOWED_VOICE_MIME_TYPES.includes(f.type)) {
      setErrorMsg(lang === "ja"
        ? "対応していない音声形式です。MP3 / WAV / MP4 / OGG のファイルを選択してください"
        : "Unsupported audio format. Please select an MP3 / WAV / MP4 / OGG file.");
      return;
    }
    if (f.size > MAX_VOICE_FILE_SIZE) {
      setErrorMsg(lang === "ja"
        ? "ファイルサイズが大きすぎます。10MB以下の音声ファイルを選択してください"
        : "File is too large. Please select an audio file under 10MB.");
      return;
    }
    setFile(f);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) validateAndSetFile(f);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (isDefault || uploading) return;
    const f = e.dataTransfer.files?.[0];
    if (f) validateAndSetFile(f);
  };

  const handleClearFile = () => {
    setFile(null);
    setErrorMsg(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClone = async () => {
    if (!canSubmit || !file) return;
    setUploading(true);
    setErrorMsg(null);
    try {
      const form = new FormData();
      form.append("name", trimmedName);
      form.append("audio", file);
      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/avatar/configs/${configId}/voice-clone`,
        { method: "POST", body: form }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        // サーバーの優しい日本語メッセージのみ表示（英語エラーコードは画面に出さない）
        const serverMsg =
          typeof d.error === "string" && JA_TEXT_RE.test(d.error) ? d.error : null;
        setErrorMsg(serverMsg ?? fallbackError);
        return;
      }
      const data = await res.json() as { voiceId: string };
      setFile(null);
      setCloneName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      onCloneSuccess(data.voiceId);
    } catch (e) {
      if (e instanceof Error && e.message === "__AUTH_REQUIRED__") {
        setErrorMsg(lang === "ja"
          ? "セッションが切れました。ページを再読み込みしてください"
          : "Session expired. Please reload the page.");
      } else {
        setErrorMsg(fallbackError);
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={SECTION_STYLE}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)", margin: "0 0 8px" }}>
        {lang === "ja" ? "音声クローン" : "Voice Clone"}
      </h2>
      <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: "0 0 16px", lineHeight: 1.6 }}>
        {lang === "ja"
          ? "お手持ちの音声ファイルから、アバター専用の声を作成できます。推奨: 1〜2分程度、背景ノイズのない音声。作成には30〜60秒ほどかかります。"
          : "Create a custom voice for your avatar from an audio file. Recommended: 1-2 minutes of clean audio without background noise. Creation takes about 30-60 seconds."}
      </p>

      {isDefault ? (
        <p style={{ fontSize: 14, color: "var(--muted-foreground)", padding: "12px 14px", borderRadius: 10, border: "1px dashed var(--border)", margin: 0 }}>
          {lang === "ja"
            ? "既定アバターの音声は変更できません"
            : "The default avatar's voice cannot be changed."}
        </p>
      ) : (
        <>
          {/* ファイル選択（ドラッグ＆ドロップ + クリック） */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => { if (!uploading) fileInputRef.current?.click(); }}
            style={{
              border: `2px dashed ${dragOver ? "#60a5fa" : "var(--border)"}`,
              borderRadius: 12,
              padding: "24px 16px",
              textAlign: "center",
              background: dragOver ? "rgba(96,165,250,0.06)" : "rgba(255,255,255,0.02)",
              cursor: uploading ? "not-allowed" : "pointer",
              transition: "all 0.15s",
              marginBottom: 12,
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp3,.wav,.m4a,.mp4,.ogg,audio/mpeg,audio/wav,audio/mp4,audio/ogg"
              style={{ display: "none" }}
              onChange={handleFileChange}
              disabled={uploading}
              aria-label={lang === "ja" ? "音声ファイルを選択" : "Select audio file"}
            />
            <div style={{ fontSize: 28, marginBottom: 6 }}>🎙️</div>
            <div style={{ fontSize: 14, color: "var(--muted-foreground)" }}>
              {lang === "ja"
                ? "音声ファイルをここにドラッグ＆ドロップ、またはクリックして選択"
                : "Drag & drop an audio file here, or click to select"}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
              {lang === "ja" ? "対応形式: MP3, WAV, MP4, OGG（10MB以内）" : "Supported: MP3, WAV, MP4, OGG (max 10MB)"}
            </div>
          </div>

          {/* 選択中のファイル */}
          {file && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "10px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "rgba(30,41,59,0.6)" }}>
              <span style={{ fontSize: 13, color: "var(--foreground)", flex: 1, minWidth: 0, wordBreak: "break-word" }}>
                🎵 {file.name}
              </span>
              <span style={{ fontSize: 12, color: "var(--muted-foreground)", flexShrink: 0 }}>
                {(file.size / 1024 / 1024).toFixed(1)}MB
              </span>
              {!uploading && (
                <button
                  onClick={handleClearFile}
                  aria-label={lang === "ja" ? "ファイルを取り消す" : "Remove file"}
                  style={{
                    padding: "4px 10px", minHeight: 28, borderRadius: 6,
                    border: "1px solid var(--border)", background: "transparent",
                    color: "var(--muted-foreground)", fontSize: 12, cursor: "pointer", flexShrink: 0,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          )}

          {/* クローン名 */}
          <div style={{ marginBottom: 12 }}>
            <label style={LABEL_STYLE}>
              {lang === "ja" ? "クローン名" : "Clone Name"}
            </label>
            <input
              type="text"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              maxLength={100}
              disabled={uploading}
              placeholder={lang === "ja" ? "例: やわらかい女性の声" : "e.g. Soft female voice"}
              style={INPUT_STYLE}
            />
          </div>

          {/* エラー */}
          {errorMsg && (
            <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5", fontSize: 14 }}>
              {errorMsg}
            </div>
          )}

          {/* 作成ボタン */}
          <button
            onClick={() => void handleClone()}
            disabled={!canSubmit}
            style={{
              ...BTN_PRIMARY,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {uploading
              ? (lang === "ja" ? "音声クローンを作成中..." : "Creating voice clone...")
              : (lang === "ja" ? "音声クローンを作成する" : "Create Voice Clone")}
          </button>

          {currentVoiceId && (
            <p style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 10, marginBottom: 0 }}>
              {lang === "ja"
                ? "作成すると、このアバターの声が新しいクローンに切り替わります"
                : "Creating a clone will replace this avatar's current voice."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
