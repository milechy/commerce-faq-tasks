// admin-ui/src/pages/admin/avatar/StudioVoiceSection.tsx
// studio.tsx から抽出 — 3. 声マッチングセクション（機能変更なし）

import { useLang } from "../../../i18n/LangContext";
import type { VoiceRecommendation } from "./types";
import { SECTION_STYLE, LABEL_STYLE, INPUT_STYLE, TEXTAREA_STYLE, BTN_PRIMARY } from "./types";

export function StudioVoiceSection({
  isDefault,
  voiceDesc,
  setVoiceDesc,
  matchingVoice,
  handleMatchVoice,
  voiceRecs,
  selectedVoiceId,
  handleSelectVoice,
  voiceId,
  setVoiceId,
}: {
  isDefault: boolean;
  voiceDesc: string;
  setVoiceDesc: (v: string) => void;
  matchingVoice: boolean;
  handleMatchVoice: () => Promise<void>;
  voiceRecs: VoiceRecommendation[];
  selectedVoiceId: string | null;
  handleSelectVoice: (rec: VoiceRecommendation) => void;
  voiceId: string;
  setVoiceId: (v: string) => void;
}) {
  const { lang } = useLang();

  return (
    <div style={SECTION_STYLE}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)", margin: "0 0 16px" }}>
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
        disabled={isDefault || matchingVoice || !voiceDesc.trim()}
        style={{
          ...BTN_PRIMARY,
          opacity: isDefault || matchingVoice || !voiceDesc.trim() ? 0.5 : 1,
          cursor: isDefault || matchingVoice || !voiceDesc.trim() ? "not-allowed" : "pointer",
        }}
      >
        {matchingVoice
          ? (lang === "ja" ? "マッチング中..." : "Matching...")
          : (lang === "ja" ? "声を検索する" : "Find Voices")}
      </button>

      {voiceRecs.length > 0 && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 13, color: "var(--muted-foreground)", marginBottom: 4 }}>
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
                  : "1px solid var(--border)",
                background: selectedVoiceId === rec.id
                  ? "rgba(99,102,241,0.1)"
                  : "rgba(30,41,59,0.6)",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>{rec.title}</span>
                <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                  {Math.round(rec.score * 100)}%
                </span>
              </div>
              <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: 0, lineHeight: 1.5 }}>{rec.description}</p>
            </div>
          ))}
        </div>
      )}

      {(voiceId || isDefault) && (
        <div style={{ marginTop: 14 }}>
          <label style={LABEL_STYLE}>
            {isDefault
              ? (lang === "ja" ? "設定済みの声 (Voice ID)" : "Configured Voice (Voice ID)")
              : "Voice ID"}
          </label>
          <input
            type="text"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            readOnly={isDefault}
            style={{
              ...INPUT_STYLE,
              ...(isDefault ? { background: "var(--card)", color: "var(--muted-foreground)", cursor: "default" } : {}),
            }}
          />
          {isDefault && (
            <p style={{ fontSize: 11, color: "#4b5563", marginTop: 4, marginBottom: 0 }}>
              {lang === "ja" ? "デフォルト設定 — 変更不可" : "Default setting — read-only"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
