import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import type { TenantFeatures, TenantDetail } from "./types";
import { CARD_STYLE, INPUT_STYLE, LABEL_STYLE } from "./types";

// ─── タブ: アバター設定 ────────────────────────────────────────────────────────

export function AvatarTab({
  tenant,
  onUpdate,
  updateAvatarSettings,
}: {
  tenant: TenantDetail;
  onUpdate: (updated: TenantDetail) => void;
  updateAvatarSettings: (
    tenantId: string,
    features: TenantFeatures,
    lemonslice_agent_id: string | null
  ) => Promise<TenantDetail>;
}) {
  const { t } = useLang();
  const navigate = useNavigate();
  const [avatarEnabled, setAvatarEnabled] = useState(tenant.features.avatar);
  const [voiceEnabled, setVoiceEnabled] = useState(tenant.features.voice);
  const [preDispatchEnabled, setPreDispatchEnabled] = useState(tenant.features.pre_dispatch ?? false);
  const [agentId, setAgentId] = useState(tenant.lemonslice_agent_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateAvatarSettings(
        tenant.id,
        { avatar: avatarEnabled, voice: voiceEnabled, rag: tenant.features.rag, pre_dispatch: preDispatchEnabled },
        agentId.trim() || null
      );
      onUpdate(updated);
    } catch {
      setError("保存に失敗しました。もう一度お試しください 🙏");
    } finally {
      setSaving(false);
    }
  };

  const toggleStyle = (on: boolean, disabled?: boolean): React.CSSProperties => ({
    padding: "10px 20px",
    minHeight: 44,
    borderRadius: 10,
    border: `1px solid ${on ? "rgba(74,222,128,0.4)" : "rgba(107,114,128,0.4)"}`,
    background: on ? "rgba(34,197,94,0.2)" : "rgba(107,114,128,0.2)",
    color: disabled ? "#4b5563" : on ? "#4ade80" : "#9ca3af",
    fontSize: 14,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ヘッダー説明 */}
      <div
        style={{
          padding: "16px 18px",
          borderRadius: 12,
          background: "rgba(59,130,246,0.08)",
          border: "1px solid rgba(96,165,250,0.2)",
          color: "#93c5fd",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <p style={{ margin: "0 0 4px", fontWeight: 700, color: "#bfdbfe", fontSize: 14 }}>
          🤖 AIアバター（有料オプション）
        </p>
        お客様との会話にAIアバターを表示します。LiveKitによるリアルタイム映像で、より親しみやすい接客を実現します。
      </div>

      {error && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* AIアバタートグル */}
      <div
        style={{
          ...CARD_STYLE,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "var(--foreground)", fontSize: 15 }}>
            AIアバターを有効にする
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>
            {avatarEnabled ? "アバター表示が有効（Widget側で表示されます）" : "現在はテキストチャットのみ"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const next = !avatarEnabled;
            setAvatarEnabled(next);
            if (!next) setVoiceEnabled(false);
          }}
          style={toggleStyle(avatarEnabled)}
        >
          {avatarEnabled ? "✅ 有効" : "⏸️ 無効"}
        </button>
      </div>

      {/* 音声会話トグル */}
      <div
        style={{
          ...CARD_STYLE,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          opacity: avatarEnabled ? 1 : 0.6,
        }}
      >
        <div>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "var(--foreground)", fontSize: 15 }}>
            音声会話を有効にする
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>
            {!avatarEnabled
              ? "AIアバターを有効にすると使用できます"
              : voiceEnabled
              ? "お客様がマイクで話しかけられます"
              : "テキスト入力のみ（マイク不使用）"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { if (avatarEnabled) setVoiceEnabled((v) => !v); }}
          disabled={!avatarEnabled}
          style={toggleStyle(voiceEnabled, !avatarEnabled)}
        >
          {voiceEnabled ? "🎤 有効" : "⏸️ 無効"}
        </button>
      </div>

      {/* アバター事前起動（Pre-dispatch）トグル */}
      <div
        style={{
          ...CARD_STYLE,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          opacity: avatarEnabled ? 1 : 0.6,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "var(--foreground)", fontSize: 15 }}>
            アバター事前起動（高速表示）
          </p>
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--muted-foreground)" }}>
            {preDispatchEnabled
              ? "ページ表示時にアバターを起動 — チャットを開くと即座に表示されます"
              : "チャットを開いた時点でアバターを起動（デフォルト）"}
          </p>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: preDispatchEnabled
                ? "rgba(234,179,8,0.08)"
                : "rgba(107,114,128,0.08)",
              border: `1px solid ${preDispatchEnabled ? "rgba(234,179,8,0.25)" : "rgba(107,114,128,0.2)"}`,
              fontSize: 12,
              color: preDispatchEnabled ? "#fbbf24" : "var(--muted-foreground)",
              lineHeight: 1.6,
            }}
          >
            {preDispatchEnabled ? (
              <>
                ⚠️ <strong>コスト増加あり</strong>：チャットを開かなかったページ閲覧でもLemonSlice APIが起動します。
                ページ表示1回あたり約30〜60秒分のアバターセッションコストが発生します。
                チャット開封率が高いテナント向けです。
              </>
            ) : (
              <>
                💡 チャットを開いたユーザーのみコストが発生します。初回表示は数秒の読み込みが入ります。
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { if (avatarEnabled) setPreDispatchEnabled((v) => !v); }}
          disabled={!avatarEnabled}
          style={toggleStyle(preDispatchEnabled, !avatarEnabled)}
        >
          {preDispatchEnabled ? "⚡ 有効" : "⏸️ 無効"}
        </button>
      </div>

      {/* Lemonslice Agent ID */}
      <div style={CARD_STYLE}>
        <label style={LABEL_STYLE}>Lemonslice Agent ID</label>
        <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "0 0 8px", lineHeight: 1.5 }}>
          Lemonslice管理画面で発行したエージェントIDを入力してください。空欄の場合はアバターが起動しません。
        </p>
        <input
          type="text"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="例: agent_xxxxxxxxxxxxxxxx"
          style={{ ...INPUT_STYLE, fontFamily: "monospace", fontSize: 14 }}
        />
      </div>

      <button
        type="button"
        onClick={() => navigate(`/admin/avatar/studio?tenant=${encodeURIComponent(tenant.id)}`)}
        style={{
          padding: "14px 24px",
          minHeight: 48,
          borderRadius: 12,
          border: "1px solid rgba(99,102,241,0.4)",
          background: "rgba(99,102,241,0.12)",
          color: "#a5b4fc",
          fontSize: 15,
          fontWeight: 700,
          cursor: "pointer",
          width: "100%",
        }}
      >
        🎭 このテナントにアバターを新規作成
      </button>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        style={{
          padding: "16px 24px",
          minHeight: 56,
          borderRadius: 12,
          border: "none",
          background: saving
            ? "rgba(34,197,94,0.3)"
            : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: "#022c22",
          fontSize: 17,
          fontWeight: 700,
          cursor: saving ? "not-allowed" : "pointer",
          width: "100%",
        }}
      >
        {saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  );
}
