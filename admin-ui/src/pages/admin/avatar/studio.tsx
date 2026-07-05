// admin-ui/src/pages/admin/avatar/studio.tsx
// Phase41: Avatar Customization Studio — 新規作成 / 編集

import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { authFetch, API_BASE } from "../../../lib/api";
import { containsBannedWord } from "../../../lib/contentGuard";
import type { VoiceRecommendation } from "./types";
import { BG } from "./types";
import { StudioBasicSection } from "./StudioBasicSection";
import { StudioImageSection } from "./StudioImageSection";
import { StudioVoiceSection } from "./StudioVoiceSection";
import { StudioVoiceCloneSection } from "./StudioVoiceCloneSection";
import { StudioPersonalitySection } from "./StudioPersonalitySection";
import { StudioFooterActions } from "./StudioFooterActions";

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
  agent_prompt: string | null;
  agent_idle_prompt: string | null;
}

export default function AvatarStudioPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const tenantQueryParam = searchParams.get("tenant") ?? undefined;
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

  // デフォルトアバター専用フィールド（読み取り専用）
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentIdlePrompt, setAgentIdlePrompt] = useState("");

  // デフォルトアバターの初期ロード値（保存時の上書き防止用）
  const initialProtectedValues = useRef<{
    voice_id: string;
    personality_prompt: string;
    agent_prompt: string;
    agent_idle_prompt: string;
  } | null>(null);

  // 保存
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [imageDescError, setImageDescError] = useState<string | null>(null);

  // 編集時: 既存データ取得
  const fetchExisting = useCallback(async () => {
    if (!id) return;
    setLoadingEdit(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs/${id}`);
      if (!res.ok) return;
      const found = await res.json() as AvatarConfig;
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
        setAgentPrompt(found.agent_prompt ?? "");
        setAgentIdlePrompt(found.agent_idle_prompt ?? "");
        if (found.is_default) {
          initialProtectedValues.current = {
            voice_id: found.voice_id ?? "",
            personality_prompt: found.personality_prompt ?? "",
            agent_prompt: found.agent_prompt ?? "",
            agent_idle_prompt: found.agent_idle_prompt ?? "",
          };
        }
      }
    } catch { /* silent */ } finally {
      setLoadingEdit(false);
    }
  }, [id]);

  useEffect(() => { void fetchExisting(); }, [fetchExisting]);

  const handleGenerateImage = async () => {
    if (!imageDesc.trim() || generatingImage) return;
    // Phase5-D: 禁止ワードチェック（フロントエンド第一防衛線）
    if (containsBannedWord(imageDesc)) {
      setImageDescError("このプロンプトは使用できません。ビジネスに適した表現に変更してください");
      return;
    }
    setImageDescError(null);
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
    if (isDefault || !voiceDesc.trim() || matchingVoice) return;
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
    if (isDefault || !promptRules.trim() || generatingPrompt) return;
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
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs/${id}/reset-to-default`, {
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
    // デフォルトアバターの保護フィールドは初期ロード値で上書き（UI操作による変更を無効化）
    const protectedVoiceId = isDefault && initialProtectedValues.current
      ? initialProtectedValues.current.voice_id
      : voiceId;
    const protectedPersonalityPrompt = isDefault && initialProtectedValues.current
      ? initialProtectedValues.current.personality_prompt
      : personalityPrompt;

    const payload = {
      name: name.trim(),
      image_url: imageUrl || undefined,
      voice_id: protectedVoiceId || undefined,
      voice_description: voiceDescription || undefined,
      personality_prompt: protectedPersonalityPrompt || undefined,
      behavior_description: behaviorDescription || undefined,
      emotion_tags: emotionTags.length > 0 ? emotionTags : undefined,
      lemonslice_agent_id: lemonsliceAgentId || undefined,
      avatar_provider: 'lemonslice' as const,
      // super_admin 用: URL ?tenant= でテナントを指定 (編集時は不要)
      ...(!isEdit && tenantQueryParam ? { tenant_id: tenantQueryParam } : {}),
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
      <div style={{ minHeight: "100vh", background: BG, color: "var(--muted-foreground)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>
        {lang === "ja" ? "読み込み中..." : "Loading..."}
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "var(--foreground)", padding: "24px 20px", maxWidth: 800, margin: "0 auto" }}>
      {/* ヘッダー */}
      <header style={{ marginBottom: 28 }}>
        <button
          onClick={() => navigate("/admin/avatar")}
          style={{ background: "none", border: "none", color: "var(--muted-foreground)", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 10, display: "block" }}
        >
          {lang === "ja" ? "← アバター一覧に戻る" : "← Back to Avatar List"}
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
          {isEdit
            ? (lang === "ja" ? "アバター編集" : "Edit Avatar")
            : (lang === "ja" ? "アバタースタジオ" : "Avatar Studio")}
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 4, marginBottom: 0 }}>
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
      <StudioBasicSection
        name={name}
        setName={setName}
        lemonsliceAgentId={lemonsliceAgentId}
        setLemonsliceAgentId={setLemonsliceAgentId}
      />

      {/* 2. アバター画像 */}
      <StudioImageSection
        isDefault={isDefault}
        imageUrl={imageUrl}
        setImageUrl={setImageUrl}
        imageTab={imageTab}
        setImageTab={setImageTab}
        imageDesc={imageDesc}
        setImageDesc={setImageDesc}
        imageDescError={imageDescError}
        setImageDescError={setImageDescError}
        generatingImage={generatingImage}
        generatedImages={generatedImages}
        selectedImageIdx={selectedImageIdx}
        handleGenerateImage={handleGenerateImage}
        handleSelectImage={handleSelectImage}
        uploadPreview={uploadPreview}
        uploadConfirmed={uploadConfirmed}
        handleFileUpload={handleFileUpload}
        handleConfirmUpload={handleConfirmUpload}
        handleResetUpload={handleResetUpload}
        fileInputRef={fileInputRef}
      />

      {/* 3. 声マッチング */}
      <StudioVoiceSection
        isDefault={isDefault}
        voiceDesc={voiceDesc}
        setVoiceDesc={setVoiceDesc}
        matchingVoice={matchingVoice}
        handleMatchVoice={handleMatchVoice}
        voiceRecs={voiceRecs}
        selectedVoiceId={selectedVoiceId}
        handleSelectVoice={handleSelectVoice}
        voiceId={voiceId}
        setVoiceId={setVoiceId}
      />

      {/* 3.5 音声クローン（FishAudio Phase C-1、編集時のみ — 作成前は対象 config が無い） */}
      {isEdit && id && (
        <StudioVoiceCloneSection
          configId={id}
          currentVoiceId={voiceId || null}
          isDefault={isDefault}
          onCloneSuccess={(newVoiceId) => {
            // クローンは API 側で即時 DB 反映済み。voiceId state を新値に同期しておけば
            // 「保存」ボタンは同値 UPDATE になり二重更新は無害。
            setVoiceId(newVoiceId);
            setSelectedVoiceId(null);
            setError(null);
            setSuccess(lang === "ja"
              ? "音声クローンを作成しました。このアバターの声に設定済みです"
              : "Voice clone created and set as this avatar's voice.");
          }}
        />
      )}

      {/* 4. パーソナリティ */}
      <StudioPersonalitySection
        isDefault={isDefault}
        promptRules={promptRules}
        setPromptRules={setPromptRules}
        generatingPrompt={generatingPrompt}
        handleGeneratePrompt={handleGeneratePrompt}
        personalityPrompt={personalityPrompt}
        setPersonalityPrompt={setPersonalityPrompt}
        agentPrompt={agentPrompt}
        agentIdlePrompt={agentIdlePrompt}
        behaviorDescription={behaviorDescription}
        setBehaviorDescription={setBehaviorDescription}
        emotionTags={emotionTags}
      />

      {/* 保存ボタン */}
      <StudioFooterActions
        isEdit={isEdit}
        isDefault={isDefault}
        resetting={resetting}
        handleResetToDefault={handleResetToDefault}
        saving={saving}
        name={name}
        handleSave={handleSave}
      />
    </div>
  );
}
