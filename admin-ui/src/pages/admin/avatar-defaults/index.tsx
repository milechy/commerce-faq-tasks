// admin-ui/src/pages/admin/avatar-defaults/index.tsx
// Phase44: Super Admin only — default avatar template image management

import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { API_BASE } from "../../../lib/api";
import { supabase } from "../../../lib/supabaseClient";

interface TemplateSlot {
  id: string;
  name: string;
}

const DEFAULT_TEMPLATES: TemplateSlot[] = [
  { id: 'default_01', name: 'さくら' },
  { id: 'default_02', name: 'あおい' },
  { id: 'default_03', name: 'ひなた' },
  { id: 'default_04', name: 'みずき' },
  { id: 'default_05', name: 'りん' },
  { id: 'default_06', name: 'かえで' },
  { id: 'default_07', name: 'すずな' },
  { id: 'default_08', name: 'つむぎ' },
];

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "rgba(15,23,42,0.95)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

export default function AvatarDefaultsPage() {
  const navigate = useNavigate();
  const { lang } = useLang();

  // imageUrls: templateId → current preview URL (after successful upload)
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  // uploading: set of templateIds currently uploading
  const [uploading, setUploading] = useState<Set<string>>(new Set());
  // feedbacks: templateId → { type: 'success' | 'error', message: string }
  const [feedbacks, setFeedbacks] = useState<Record<string, { type: 'success' | 'error'; message: string }>>({});

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const handleFileChange = async (templateId: string, file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setFeedbacks((prev) => ({
        ...prev,
        [templateId]: {
          type: 'error',
          message: lang === "ja" ? "ファイルサイズは5MB以下にしてください" : "File size must be 5MB or less",
        },
      }));
      return;
    }

    setUploading((prev) => { const s = new Set(prev); s.add(templateId); return s; });
    setFeedbacks((prev) => { const n = { ...prev }; delete n[templateId]; return n; });

    try {
      // authFetch sets Content-Type: application/json by default; for FormData
      // we must omit it and let the browser set multipart/form-data boundary.
      // We obtain the session token directly from supabase (same as authFetch).
      const { data: sessionData } = await supabase.auth.getSession();
      let accessToken = sessionData.session?.access_token ?? null;
      if (!accessToken) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        accessToken = refreshed.session?.access_token ?? null;
      }
      if (!accessToken) {
        setFeedbacks((prev) => ({
          ...prev,
          [templateId]: {
            type: 'error',
            message: lang === "ja" ? "セッションが切れました。ページを再読み込みしてください" : "Session expired. Please reload.",
          },
        }));
        return;
      }

      const formData = new FormData();
      formData.append("template_id", templateId);
      formData.append("file", file);

      const res = await fetch(`${API_BASE}/v1/admin/avatar/defaults/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: formData,
      });

      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setFeedbacks((prev) => ({
          ...prev,
          [templateId]: {
            type: 'error',
            message: d.error ?? (lang === "ja" ? "アップロードに失敗しました" : "Upload failed"),
          },
        }));
        return;
      }

      const data = await res.json() as { url?: string; image_url?: string };
      const newUrl = data.url ?? data.image_url ?? "";

      // Show local preview immediately
      const objectUrl = URL.createObjectURL(file);
      setImageUrls((prev) => ({ ...prev, [templateId]: newUrl || objectUrl }));
      setFeedbacks((prev) => ({
        ...prev,
        [templateId]: {
          type: 'success',
          message: lang === "ja" ? "アップロードしました" : "Uploaded successfully",
        },
      }));
    } catch (e) {
      console.error("[AvatarDefaults] upload error", e);
      setFeedbacks((prev) => ({
        ...prev,
        [templateId]: {
          type: 'error',
          message: lang === "ja" ? "ネットワークエラーが発生しました" : "A network error occurred",
        },
      }));
    } finally {
      setUploading((prev) => { const s = new Set(prev); s.delete(templateId); return s; });
      // Reset file input so same file can be re-selected
      const input = fileInputRefs.current[templateId];
      if (input) input.value = "";
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 1000, margin: "0 auto" }}>
      {/* ヘッダー */}
      <header style={{ marginBottom: 28 }}>
        <button
          onClick={() => navigate("/admin")}
          style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 10, display: "block" }}
        >
          {lang === "ja" ? "← 管理画面に戻る" : "← Back to Admin"}
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
          {lang === "ja" ? "デフォルトアバター管理" : "Default Avatar Management"}
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4, marginBottom: 0 }}>
          {lang === "ja"
            ? "8種類のデフォルトアバターテンプレートの画像を管理します（Super Admin専用）"
            : "Manage images for 8 default avatar templates (Super Admin only)"}
        </p>
      </header>

      {/* グリッド */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
        {DEFAULT_TEMPLATES.map((tmpl) => {
          const isUploading = uploading.has(tmpl.id);
          const feedback = feedbacks[tmpl.id];
          const previewUrl = imageUrls[tmpl.id];

          return (
            <div key={tmpl.id} style={CARD_STYLE}>
              {/* サムネイル */}
              <div style={{
                width: "100%",
                height: 160,
                background: "rgba(30,41,59,0.8)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}>
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={tmpl.name}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <span style={{ fontSize: 48, color: "#374151" }}>👤</span>
                )}
              </div>

              {/* コンテンツ */}
              <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                {/* テンプレートID + 名前 */}
                <div>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", display: "block" }}>
                    {tmpl.name}
                  </span>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>{tmpl.id}</span>
                </div>

                {/* フィードバック */}
                {feedback && (
                  <div style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    fontSize: 12,
                    background: feedback.type === 'success'
                      ? "rgba(34,197,94,0.1)"
                      : "rgba(239,68,68,0.12)",
                    border: feedback.type === 'success'
                      ? "1px solid rgba(34,197,94,0.4)"
                      : "1px solid rgba(239,68,68,0.4)",
                    color: feedback.type === 'success' ? "#4ade80" : "#fca5a5",
                  }}>
                    {feedback.message}
                  </div>
                )}

                {/* アップロードボタン */}
                <button
                  onClick={() => fileInputRefs.current[tmpl.id]?.click()}
                  disabled={isUploading}
                  style={{
                    padding: "10px 16px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid #374151",
                    background: isUploading ? "rgba(30,41,59,0.4)" : "rgba(30,41,59,0.8)",
                    color: isUploading ? "#6b7280" : "#e5e7eb",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: isUploading ? "not-allowed" : "pointer",
                    opacity: isUploading ? 0.6 : 1,
                    width: "100%",
                  }}
                >
                  {isUploading
                    ? (lang === "ja" ? "アップロード中..." : "Uploading...")
                    : (lang === "ja" ? "画像をアップロード" : "Upload Image")}
                </button>

                {/* 非表示ファイルインプット */}
                <input
                  ref={(el) => { fileInputRefs.current[tmpl.id] = el; }}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFileChange(tmpl.id, file);
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
