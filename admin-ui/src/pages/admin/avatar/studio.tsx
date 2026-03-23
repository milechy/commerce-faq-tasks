// admin-ui/src/pages/admin/avatar/studio.tsx
// Phase41: Avatar Customization Studio — 新規作成 / 編集

import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { authFetch, API_BASE } from "../../../lib/api";

interface AvatarConfig {
  id: string;
  name: string;
  image_url: string | null;
  image_prompt: string | null;
  voice_id: string | null;
  voice_description: string | null;
  personality_prompt: string | null;
  behavior_description: string | null;
  emotion_tags: string[];
  lemonslice_agent_id: string | null;
  is_active: boolean;
  is_default: boolean;
  avatar_provider: string | null;
}

interface VoiceRecommendation {
  id: string;
  title: string;
  description: string;
  score: number;
}

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

const SECTION_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "rgba(15,23,42,0.95)",
  padding: "20px 22px",
  marginBottom: 20,
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#9ca3af",
  marginBottom: 6,
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #374151",
  background: "rgba(30,41,59,0.8)",
  color: "#f9fafb",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

const TEXTAREA_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  resize: "vertical",
  minHeight: 90,
  fontFamily: "inherit",
  lineHeight: 1.5,
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: "10px 20px",
  minHeight: 44,
  borderRadius: 10,
  border: "none",
  background: "linear-gradient(135deg, #3b82f6, #6366f1)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const BTN_SECONDARY: React.CSSProperties = {
  padding: "10px 18px",
  minHeight: 44,
  borderRadius: 10,
  border: "1px solid #374151",
  background: "transparent",
  color: "#9ca3af",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

export default function AvatarStudioPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const { lang } = useLang();
  const isEdit = Boolean(id);

  // フォーム状態
  const [name, setName] = useState("");
  const [lemonsliceAgentId, setLemonsliceAgentId] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [voiceDescription, setVoiceDescription] = useState("");
  const [personalityPrompt, setPersonalityPrompt] = useState("");
  const [behaviorDescription, setBehaviorDescription] = useState("");
  const [emotionTags, setEmotionTags] = useState<string[]>([]);

  // 画像タブ
  const [imageTab, setImageTab] = useState<'generate' | 'upload'>('generate');

  // 画像生成（AIタブ）
  const [imageDesc, setImageDesc] = useState("");
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [selectedImageIdx, setSelectedImageIdx] = useState<number | null>(null);

  // 写真アップロード（アップロードタブ）
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadConfirmed, setUploadConfirmed] = useState(false);
  void uploadFile; // 将来Supabase Storage連携で使用

  // 声マッチング
  const [voiceDesc, setVoiceDesc] = useState("");
  const [voiceRecs, setVoiceRecs] = useState<VoiceRecommendation[]>([]);
  const [matchingVoice, setMatchingVoice] = useState(false);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);

  // プロンプト生成
  const [promptRules, setPromptRules] = useState("");
  const [generatingPrompt, setGeneratingPrompt] = useState(false);

  // デフォルトアバターフラグ
  const [isDefault, setIsDefault] = useState(false);
  const [resetting, setResetting] = useState(false);

  // 保存
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // 編集時: 既存データ取得
  const fetchExisting = useCallback(async () => {
    if (!id) return;
    setLoadingEdit(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs`);
      if (!res.ok) return;
      const data = await res.json() as { configs: AvatarConfig[] };
      const found = data.configs.find((c) => c.id === id);
      if (found) {
        setName(found.name);
        setLemonsliceAgentId(found.lemonslice_agent_id ?? "");
        setImageUrl(found.image_url ?? "");
        setVoiceId(found.voice_id ?? "");
        setVoiceDescription(found.voice_description ?? "");
        setPersonalityPrompt(found.personality_prompt ?? "");
        setBehaviorDescription(found.behavior_description ?? "");
        setEmotionTags(found.emotion_tags ?? []);
        setIsDefault(found.is_default ?? false);
      }
    } catch { /* silent */ } finally {
      setLoadingEdit(false);
    }
  }, [id]);

  useEffect(() => { void fetchExisting(); }, [fetchExisting]);

  const handleGenerateImage = async () => {
    if (!imageDesc.trim() || generatingImage) return;
    setGeneratingImage(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: imageDesc }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? (lang === "ja" ? "画像生成に失敗しました" : "Image generation failed"));
        return;
      }
      const data = await res.json() as { images: string[] };
      setGeneratedImages(data.images ?? []);
      setSelectedImageIdx(null);
    } catch (e) {
      console.error("[handleGenerateImage]", e);
      if (e instanceof Error && e.message === "__AUTH_REQUIRED__") {
        setError(lang === "ja" ? "セッションが切れました。ページを再読み込みしてください" : "Session expired. Please reload the page.");
      } else {
        setError(lang === "ja" ? "ネットワークエラーが発生しました" : "Network error");
      }
    } finally {
      setGeneratingImage(false);
    }
  };

  const handleSelectImage = (idx: number) => {
    setSelectedImageIdx(idx);
    setImageUrl(generatedImages[idx] ?? "");
    // AI生成画像選択時はアップロード確定状態をリセット
    setUploadConfirmed(false);
    setUploadPreview(null);
    setUploadFile(null);
  };

  function handleFileUpload(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      alert(lang === "ja" ? "ファイルサイズは5MB以下にしてください" : "File size must be 5MB or less");
      return;
    }
    setUploadFile(file);
    setUploadConfirmed(false);
    const reader = new FileReader();
    reader.onload = (e) => {
      setUploadPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }

  function handleConfirmUpload() {
    if (!uploadPreview) return;
    setImageUrl(uploadPreview);
    setUploadConfirmed(true);
  }

  function handleResetUpload() {
    setUploadFile(null);
    setUploadPreview(null);
    setUploadConfirmed(false);
    if (imageUrl.startsWith("data:")) setImageUrl("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const handleMatchVoice = async () => {
    if (!voiceDesc.trim() || matchingVoice) return;
    setMatchingVoice(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/match-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: voiceDesc }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? (lang === "ja" ? "声マッチングに失敗しました" : "Voice matching failed"));
        return;
      }
      const data = await res.json() as { recommendations: VoiceRecommendation[] };
      setVoiceRecs(data.recommendations ?? []);
      setSelectedVoiceId(null);
    } catch (e) {
      console.error("[handleMatchVoice]", e);
      if (e instanceof Error && e.message === "__AUTH_REQUIRED__") {
        setError(lang === "ja" ? "セッションが切れました。ページを再読み込みしてください" : "Session expired. Please reload the page.");
      } else {
        setError(lang === "ja" ? "ネットワークエラーが発生しました" : "Network error");
      }
    } finally {
      setMatchingVoice(false);
    }
  };

  const handleSelectVoice = (rec: VoiceRecommendation) => {
    setSelectedVoiceId(rec.id);
    setVoiceId(rec.id);
    setVoiceDescription(rec.description);
  };

  const handleGeneratePrompt = async () => {
    if (!promptRules.trim() || generatingPrompt) return;
    setGeneratingPrompt(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/generate-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: promptRules }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? (lang === "ja" ? "プロンプト生成に失敗しました" : "Prompt generation failed"));
        return;
      }
      const data = await res.json() as { system_prompt: string; emotion_tags: string[] };
      setPersonalityPrompt(data.system_prompt ?? "");
      setEmotionTags(data.emotion_tags ?? []);
    } catch (e) {
      console.error("[handleGeneratePrompt]", e);
      if (e instanceof Error && e.message === "__AUTH_REQUIRED__") {
        setError(lang === "ja" ? "セッションが切れました。ページを再読み込みしてください" : "Session expired. Please reload the page.");
      } else {
        setError(lang === "ja" ? "ネットワークエラーが発生しました" : "Network error");
      }
    } finally {
      setGeneratingPrompt(false);
    }
  };

  const handleResetToDefault = async () => {
    if (!id || resetting) return;
    const confirmed = window.confirm(
      lang === "ja"
        ? "声・性格・名前をデフォルト設定に戻しますか？"
        : "Reset voice, personality, and name to default settings?"
    );
    if (!confirmed) return;
    setResetting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar-configs/${id}/reset-to-default`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? (lang === "ja" ? "リセットに失敗しました" : "Reset failed"));
        return;
      }
      const data = await res.json() as { config?: AvatarConfig };
      if (data.config) {
        setName(data.config.name);
        setVoiceId(data.config.voice_id ?? "");
        setVoiceDescription(data.config.voice_description ?? "");
        setPersonalityPrompt(data.config.personality_prompt ?? "");
        setBehaviorDescription(data.config.behavior_description ?? "");
        setEmotionTags(data.config.emotion_tags ?? []);
      }
      setSuccess(lang === "ja" ? "デフォルト設定に戻しました" : "Reset to default settings");
    } catch (e) {
      console.error("[handleResetToDefault]", e);
      if (e instanceof Error && e.message === "__AUTH_REQUIRED__") {
        setError(lang === "ja" ? "セッションが切れました。ページを再読み込みしてください" : "Session expired. Please reload the page.");
      } else {
        setError(lang === "ja" ? "ネットワークエラーが発生しました" : "Network error");
      }
    } finally {
      setResetting(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError(lang === "ja" ? "名前を入力してください" : "Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    const payload = {
      name: name.trim(),
      image_url: imageUrl || undefined,
      voice_id: voiceId || undefined,
      voice_description: voiceDescription || undefined,
      personality_prompt: personalityPrompt || undefined,
      behavior_description: behaviorDescription || undefined,
      emotion_tags: emotionTags.length > 0 ? emotionTags : undefined,
      lemonslice_agent_id: lemonsliceAgentId || undefined,
      avatar_provider: 'lemonslice' as const,
    };
    try {
      const url = isEdit
        ? `${API_BASE}/v1/admin/avatar/configs/${id}`
        : `${API_BASE}/v1/admin/avatar/configs`;
      const method = isEdit ? "PATCH" : "POST";
      const res = await authFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? (lang === "ja" ? "保存に失敗しました" : "Save failed"));
        return;
      }
      setSuccess(lang === "ja" ? "保存しました" : "Saved successfully");
      setTimeout(() => navigate("/admin/avatar"), 800);
    } catch {
      setError(lang === "ja" ? "ネットワークエラーが発生しました" : "Network error");
    } finally {
      setSaving(false);
    }
  };

  if (loadingEdit) {
    return (
      <div style={{ minHeight: "100vh", background: BG, color: "#9ca3af", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>
        {lang === "ja" ? "読み込み中..." : "Loading..."}
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 800, margin: "0 auto" }}>
      {/* ヘッダー */}
      <header style={{ marginBottom: 28 }}>
        <button
          onClick={() => navigate("/admin/avatar")}
          style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 10, display: "block" }}
        >
          {lang === "ja" ? "← アバター一覧に戻る" : "← Back to Avatar List"}
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
          {isEdit
            ? (lang === "ja" ? "アバター編集" : "Edit Avatar")
            : (lang === "ja" ? "アバタースタジオ" : "Avatar Studio")}
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4, marginBottom: 0 }}>
          {lang === "ja"
            ? "アバターの外見・声・パーソナリティを設定します"
            : "Configure avatar appearance, voice, and personality"}
        </p>
      </header>

      {/* エラー / 成功 */}
      {error && (
        <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5", fontSize: 14 }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ marginBottom: 16, padding: "12px 16px", borderRadius: 10, background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.4)", color: "#4ade80", fontSize: 14 }}>
          {success}
        </div>
      )}

      {/* 1. 基本設定 */}
      <div style={SECTION_STYLE}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 16px" }}>
          {lang === "ja" ? "1. 基本設定" : "1. Basic Settings"}
        </h2>
        <div style={{ marginBottom: 14 }}>
          <label style={LABEL_STYLE}>{lang === "ja" ? "アバター名 *" : "Avatar Name *"}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={lang === "ja" ? "例: サポートアシスタント" : "e.g. Support Assistant"}
            style={INPUT_STYLE}
          />
        </div>
        <div>
          <label style={LABEL_STYLE}>Lemonslice Agent ID</label>
          <input type="text" value={lemonsliceAgentId} onChange={(e) => setLemonsliceAgentId(e.target.value)}
            placeholder="agent_xxxxxxxxxx" style={INPUT_STYLE} />
        </div>
      </div>

      {/* 2. アバター画像 */}
      <div style={SECTION_STYLE}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 16px" }}>
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
                border: imageTab === tab ? "2px solid #3b82f6" : "1px solid #374151",
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
                onChange={(e) => setImageDesc(e.target.value)}
                placeholder={lang === "ja"
                  ? "例: 30代の日本人女性、ショートヘア、紺色のジャケット、笑顔"
                  : "e.g. Japanese woman in 30s, short hair, navy jacket, smiling"}
                style={TEXTAREA_STYLE}
              />
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
                <p style={{ fontSize: 13, color: "#9ca3af", marginBottom: 10 }}>
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
                        background: "#111827",
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
            <p style={{ color: "#9ca3af", marginBottom: 12 }}>
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
                  style={{ background: "none", border: "none", color: "#6b7280", fontSize: 13, cursor: "pointer", textDecoration: "underline" }}
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
                      <p style={{ color: "#9ca3af", margin: "0 0 8px" }}>
                        {lang === "ja" ? "または クリックしてファイルを選択" : "or click to select a file"}
                      </p>
                      <p style={{ color: "#6b7280", fontSize: 14, margin: 0 }}>
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

      {/* 3. 声マッチング */}
      <div style={SECTION_STYLE}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 16px" }}>
          {lang === "ja" ? "3. 声マッチング" : "3. Voice Matching"}
        </h2>
        <div style={{ marginBottom: 12 }}>
          <label style={LABEL_STYLE}>{lang === "ja" ? "声の説明" : "Voice Description"}</label>
          <textarea
            value={voiceDesc}
            onChange={(e) => setVoiceDesc(e.target.value)}
            placeholder={lang === "ja"
              ? "例: 若い女性、明るく親しみやすい声、標準的な日本語"
              : "e.g. Young female, bright and friendly, standard Japanese"}
            style={TEXTAREA_STYLE}
          />
        </div>
        <button
          onClick={() => void handleMatchVoice()}
          disabled={matchingVoice || !voiceDesc.trim()}
          style={{
            ...BTN_PRIMARY,
            opacity: matchingVoice || !voiceDesc.trim() ? 0.5 : 1,
            cursor: matchingVoice || !voiceDesc.trim() ? "not-allowed" : "pointer",
          }}
        >
          {matchingVoice
            ? (lang === "ja" ? "マッチング中..." : "Matching...")
            : (lang === "ja" ? "声を検索する" : "Find Voices")}
        </button>

        {voiceRecs.length > 0 && (
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ fontSize: 13, color: "#9ca3af", marginBottom: 4 }}>
              {lang === "ja" ? "使用する声を選択してください" : "Select a voice to use"}
            </p>
            {voiceRecs.map((rec) => (
              <div
                key={rec.id}
                onClick={() => handleSelectVoice(rec)}
                style={{
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: selectedVoiceId === rec.id
                    ? "1px solid rgba(99,102,241,0.7)"
                    : "1px solid #374151",
                  background: selectedVoiceId === rec.id
                    ? "rgba(99,102,241,0.1)"
                    : "rgba(30,41,59,0.6)",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb" }}>{rec.title}</span>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>
                    {Math.round(rec.score * 100)}%
                  </span>
                </div>
                <p style={{ fontSize: 12, color: "#9ca3af", margin: 0, lineHeight: 1.5 }}>{rec.description}</p>
              </div>
            ))}
          </div>
        )}

        {voiceId && (
          <div style={{ marginTop: 14 }}>
            <label style={LABEL_STYLE}>Voice ID</label>
            <input
              type="text"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              style={INPUT_STYLE}
            />
          </div>
        )}
      </div>

      {/* 4. パーソナリティ */}
      <div style={SECTION_STYLE}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 16px" }}>
          {lang === "ja" ? "4. パーソナリティ" : "4. Personality"}
        </h2>
        <div style={{ marginBottom: 12 }}>
          <label style={LABEL_STYLE}>{lang === "ja" ? "接客ルール・ペルソナ情報" : "Rules & Persona"}</label>
          <textarea
            value={promptRules}
            onChange={(e) => setPromptRules(e.target.value)}
            placeholder={lang === "ja"
              ? "例: 丁寧な口調、商品の良い点を積極的にアピール、クレームには共感してから解決策を提示"
              : "e.g. Polite tone, proactively highlight product benefits, empathize then resolve complaints"}
            style={{ ...TEXTAREA_STYLE, minHeight: 100 }}
          />
        </div>
        <button
          onClick={() => void handleGeneratePrompt()}
          disabled={generatingPrompt || !promptRules.trim()}
          style={{
            ...BTN_PRIMARY,
            opacity: generatingPrompt || !promptRules.trim() ? 0.5 : 1,
            cursor: generatingPrompt || !promptRules.trim() ? "not-allowed" : "pointer",
          }}
        >
          {generatingPrompt
            ? (lang === "ja" ? "生成中..." : "Generating...")
            : (lang === "ja" ? "プロンプトを生成する" : "Generate Prompt")}
        </button>

        <div style={{ marginTop: 16 }}>
          <label style={LABEL_STYLE}>
            {lang === "ja" ? "システムプロンプト" : "System Prompt"}
          </label>
          <textarea
            value={personalityPrompt}
            onChange={(e) => setPersonalityPrompt(e.target.value)}
            placeholder={lang === "ja" ? "AIが生成するか、直接入力してください" : "Auto-generated or enter manually"}
            style={{ ...TEXTAREA_STYLE, minHeight: 120 }}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={LABEL_STYLE}>
            {lang === "ja" ? "行動説明" : "Behavior Description"}
          </label>
          <textarea
            value={behaviorDescription}
            onChange={(e) => setBehaviorDescription(e.target.value)}
            placeholder={lang === "ja" ? "アバターの行動特性を記述します（任意）" : "Describe behavior characteristics (optional)"}
            style={TEXTAREA_STYLE}
          />
        </div>

        {emotionTags.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <label style={LABEL_STYLE}>
              {lang === "ja" ? "感情タグ" : "Emotion Tags"}
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {emotionTags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 999,
                    background: "rgba(99,102,241,0.15)",
                    border: "1px solid rgba(99,102,241,0.4)",
                    color: "#a5b4fc",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 保存ボタン */}
      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
        {isEdit && isDefault && (
          <button
            onClick={() => void handleResetToDefault()}
            disabled={resetting}
            style={{
              ...BTN_SECONDARY,
              opacity: resetting ? 0.6 : 1,
              cursor: resetting ? "not-allowed" : "pointer",
              marginRight: "auto",
            }}
          >
            {resetting
              ? (lang === "ja" ? "リセット中..." : "Resetting...")
              : (lang === "ja" ? "デフォルトに戻す" : "Reset to Default")}
          </button>
        )}
        <button
          onClick={() => navigate("/admin/avatar")}
          style={BTN_SECONDARY}
        >
          {lang === "ja" ? "キャンセル" : "Cancel"}
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !name.trim()}
          style={{
            ...BTN_PRIMARY,
            minWidth: 120,
            opacity: saving || !name.trim() ? 0.5 : 1,
            cursor: saving || !name.trim() ? "not-allowed" : "pointer",
          }}
        >
          {saving
            ? (lang === "ja" ? "保存中..." : "Saving...")
            : (lang === "ja" ? "保存する" : "Save")}
        </button>
      </div>
    </div>
  );
}
