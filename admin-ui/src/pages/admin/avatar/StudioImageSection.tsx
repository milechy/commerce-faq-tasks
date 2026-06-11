// admin-ui/src/pages/admin/avatar/StudioImageSection.tsx
// studio.tsx から抽出 — 2. アバター画像セクション（AI生成 / 写真アップロード）（機能変更なし）

import type { RefObject } from "react";
import { useLang } from "../../../i18n/LangContext";
import { SECTION_STYLE, LABEL_STYLE, INPUT_STYLE, TEXTAREA_STYLE, BTN_PRIMARY } from "./types";

export function StudioImageSection({
  isDefault,
  imageUrl,
  setImageUrl,
  imageTab,
  setImageTab,
  imageDesc,
  setImageDesc,
  imageDescError,
  setImageDescError,
  generatingImage,
  generatedImages,
  selectedImageIdx,
  handleGenerateImage,
  handleSelectImage,
  uploadPreview,
  uploadConfirmed,
  handleFileUpload,
  handleConfirmUpload,
  handleResetUpload,
  fileInputRef,
}: {
  isDefault: boolean;
  imageUrl: string;
  setImageUrl: (v: string) => void;
  imageTab: 'generate' | 'upload';
  setImageTab: (v: 'generate' | 'upload') => void;
  imageDesc: string;
  setImageDesc: (v: string) => void;
  imageDescError: string | null;
  setImageDescError: (v: string | null) => void;
  generatingImage: boolean;
  generatedImages: string[];
  selectedImageIdx: number | null;
  handleGenerateImage: () => Promise<void>;
  handleSelectImage: (idx: number) => void;
  uploadPreview: string | null;
  uploadConfirmed: boolean;
  handleFileUpload: (file: File) => void;
  handleConfirmUpload: () => void;
  handleResetUpload: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}) {
  const { lang } = useLang();

  return (
    <div style={SECTION_STYLE}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)", margin: "0 0 16px" }}>
        {lang === "ja" ? "2. アバター画像" : "2. Avatar Image"}
      </h2>

      {/* デフォルトアバターは画像変更不可 */}
      {isDefault ? (
        <div style={{
          padding: "14px 16px",
          borderRadius: 10,
          background: "rgba(59,130,246,0.08)",
          border: "1px solid rgba(59,130,246,0.3)",
          color: "#93c5fd",
          fontSize: 14,
          marginBottom: 8,
        }}>
          {lang === "ja"
            ? "デフォルトアバターの画像は変更できません"
            : "Default avatar images cannot be changed"}
          {imageUrl && (
            <div style={{ marginTop: 12, textAlign: "center" }}>
              <img
                src={imageUrl}
                alt="avatar"
                style={{ maxHeight: 160, borderRadius: 10, display: "block", margin: "0 auto" }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            </div>
          )}
        </div>
      ) : (
        <>
      {/* タブ切り替え */}
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {(['generate', 'upload'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setImageTab(tab)}
            style={{
              padding: "8px 18px",
              minHeight: 44,
              borderRadius: 10,
              border: imageTab === tab ? "2px solid #3b82f6" : "1px solid var(--border)",
              background: imageTab === tab ? "rgba(59,130,246,0.15)" : "transparent",
              color: imageTab === tab ? "#93c5fd" : "#9ca3af",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {tab === 'generate'
              ? (lang === "ja" ? "AIで生成" : "Generate with AI")
              : (lang === "ja" ? "写真をアップロード" : "Upload Photo")}
          </button>
        ))}
      </div>

      {/* AIで生成タブ */}
      {imageTab === 'generate' && (
        <>
          <div style={{ marginBottom: 12 }}>
            <label style={LABEL_STYLE}>{lang === "ja" ? "アバターの説明" : "Avatar Description"}</label>
            <textarea
              value={imageDesc}
              onChange={(e) => { setImageDesc(e.target.value); if (imageDescError) setImageDescError(null); }}
              placeholder={lang === "ja"
                ? "例: 30代の日本人女性、ショートヘア、紺色のジャケット、笑顔"
                : "e.g. Japanese woman in 30s, short hair, navy jacket, smiling"}
              style={TEXTAREA_STYLE}
            />
            {imageDescError && (
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "#f87171" }}>{imageDescError}</p>
            )}
          </div>
          <button
            onClick={() => void handleGenerateImage()}
            disabled={generatingImage || !imageDesc.trim()}
            style={{
              ...BTN_PRIMARY,
              opacity: generatingImage || !imageDesc.trim() ? 0.5 : 1,
              cursor: generatingImage || !imageDesc.trim() ? "not-allowed" : "pointer",
            }}
          >
            {generatingImage
              ? (lang === "ja" ? "生成中..." : "Generating...")
              : (lang === "ja" ? "画像を生成する (4枚)" : "Generate Images (4)")}
          </button>

          {generatedImages.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, color: "var(--muted-foreground)", marginBottom: 10 }}>
                {lang === "ja" ? "使用する画像を選択してください" : "Select an image to use"}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                {generatedImages.map((url, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleSelectImage(idx)}
                    style={{
                      borderRadius: 10,
                      overflow: "hidden",
                      border: selectedImageIdx === idx ? "2px solid #3b82f6" : "2px solid transparent",
                      cursor: "pointer",
                      aspectRatio: "1",
                      background: "var(--muted)",
                    }}
                  >
                    <img
                      src={url}
                      alt={`Generated ${idx + 1}`}
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* 写真をアップロードタブ */}
      {imageTab === 'upload' && (
        <div>
          <p style={{ color: "var(--muted-foreground)", marginBottom: 12 }}>
            {lang === "ja" ? "顔がはっきり写った正面の写真が最適です" : "A clear front-facing photo works best"}
          </p>

          {/* 確定済み: プレビュー + 差し替えリンク */}
          {uploadConfirmed && uploadPreview ? (
            <div style={{ textAlign: "center" }}>
              <img
                src={uploadPreview}
                alt="selected"
                style={{ maxHeight: 300, borderRadius: 10, display: "block", margin: "0 auto 12px" }}
              />
              <button
                type="button"
                onClick={handleResetUpload}
                style={{ background: "none", border: "none", color: "var(--muted-foreground)", fontSize: 13, cursor: "pointer", textDecoration: "underline" }}
              >
                {lang === "ja" ? "別の画像を選ぶ" : "Choose a different image"}
              </button>
            </div>
          ) : (
            <>
              {/* ドラッグ&ドロップエリア */}
              <div
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const file = e.dataTransfer.files[0];
                  if (file && file.type.startsWith("image/")) handleFileUpload(file);
                }}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: "2px dashed #4b5563",
                  borderRadius: 12,
                  padding: 40,
                  textAlign: "center",
                  cursor: "pointer",
                  minHeight: 200,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {uploadPreview ? (
                  <img src={uploadPreview} alt="preview" style={{ maxHeight: 300, borderRadius: 8 }} />
                ) : (
                  <>
                    <p style={{ fontSize: 18, color: "white", margin: "0 0 8px" }}>
                      {lang === "ja" ? "ここに画像をドラッグ" : "Drag image here"}
                    </p>
                    <p style={{ color: "var(--muted-foreground)", margin: "0 0 8px" }}>
                      {lang === "ja" ? "または クリックしてファイルを選択" : "or click to select a file"}
                    </p>
                    <p style={{ color: "var(--muted-foreground)", fontSize: 14, margin: 0 }}>
                      JPG, PNG{lang === "ja" ? "（最大5MB）" : " (max 5MB)"}
                    </p>
                  </>
                )}
              </div>

              {/* 「この画像を使う」確定ボタン */}
              {uploadPreview && !uploadConfirmed && (
                <button
                  type="button"
                  onClick={handleConfirmUpload}
                  style={{
                    marginTop: 16,
                    padding: "14px 32px",
                    background: "#4f46e5",
                    color: "white",
                    border: "none",
                    borderRadius: 8,
                    fontSize: 16,
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  {lang === "ja" ? "この画像を使う" : "Use this image"}
                </button>
              )}
            </>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileUpload(file);
            }}
          />
        </div>
      )}

      {/* 選択中の画像URL（両タブ共通） */}
      {imageUrl && (
        <div style={{ marginTop: 14 }}>
          <label style={LABEL_STYLE}>{lang === "ja" ? "選択中の画像URL" : "Selected Image URL"}</label>
          <input
            type="text"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            style={INPUT_STYLE}
          />
        </div>
      )}
        </>
      )}
    </div>
  );
}
