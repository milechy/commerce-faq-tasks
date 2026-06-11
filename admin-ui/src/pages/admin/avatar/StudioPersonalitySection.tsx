// admin-ui/src/pages/admin/avatar/StudioPersonalitySection.tsx
// studio.tsx から抽出 — 4. パーソナリティセクション（機能変更なし）

import { useLang } from "../../../i18n/LangContext";
import { SECTION_STYLE, LABEL_STYLE, TEXTAREA_STYLE, BTN_PRIMARY } from "./types";

export function StudioPersonalitySection({
  isDefault,
  promptRules,
  setPromptRules,
  generatingPrompt,
  handleGeneratePrompt,
  personalityPrompt,
  setPersonalityPrompt,
  agentPrompt,
  agentIdlePrompt,
  behaviorDescription,
  setBehaviorDescription,
  emotionTags,
}: {
  isDefault: boolean;
  promptRules: string;
  setPromptRules: (v: string) => void;
  generatingPrompt: boolean;
  handleGeneratePrompt: () => Promise<void>;
  personalityPrompt: string;
  setPersonalityPrompt: (v: string) => void;
  agentPrompt: string;
  agentIdlePrompt: string;
  behaviorDescription: string;
  setBehaviorDescription: (v: string) => void;
  emotionTags: string[];
}) {
  const { lang } = useLang();

  return (
    <div style={SECTION_STYLE}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)", margin: "0 0 16px" }}>
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
        disabled={isDefault || generatingPrompt || !promptRules.trim()}
        style={{
          ...BTN_PRIMARY,
          opacity: isDefault || generatingPrompt || !promptRules.trim() ? 0.5 : 1,
          cursor: isDefault || generatingPrompt || !promptRules.trim() ? "not-allowed" : "pointer",
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
          readOnly={isDefault}
          placeholder={lang === "ja" ? "AIが生成するか、直接入力してください" : "Auto-generated or enter manually"}
          style={{
            ...TEXTAREA_STYLE,
            minHeight: 120,
            ...(isDefault ? { background: "var(--card)", color: "var(--muted-foreground)", cursor: "default" } : {}),
          }}
        />
        {isDefault && (
          <p style={{ fontSize: 11, color: "#4b5563", marginTop: 4, marginBottom: 0 }}>
            {lang === "ja" ? "デフォルト設定 — 変更不可" : "Default setting — read-only"}
          </p>
        )}
      </div>

      {isDefault && (agentPrompt || agentIdlePrompt) && (
        <>
          <div style={{ marginTop: 14 }}>
            <label style={LABEL_STYLE}>
              {lang === "ja" ? "動作プロンプト（会話中）" : "Agent Prompt (During Conversation)"}
            </label>
            <textarea
              value={agentPrompt}
              readOnly
              style={{ ...TEXTAREA_STYLE, background: "var(--card)", color: "var(--muted-foreground)", cursor: "default", fontStyle: "italic" }}
            />
            <p style={{ fontSize: 11, color: "#4b5563", marginTop: 4, marginBottom: 0 }}>
              {lang === "ja" ? "デフォルト設定 — 変更不可" : "Default setting — read-only"}
            </p>
          </div>
          <div style={{ marginTop: 14 }}>
            <label style={LABEL_STYLE}>
              {lang === "ja" ? "動作プロンプト（待機中）" : "Agent Prompt (Idle)"}
            </label>
            <textarea
              value={agentIdlePrompt}
              readOnly
              style={{ ...TEXTAREA_STYLE, background: "var(--card)", color: "var(--muted-foreground)", cursor: "default", fontStyle: "italic" }}
            />
            <p style={{ fontSize: 11, color: "#4b5563", marginTop: 4, marginBottom: 0 }}>
              {lang === "ja" ? "デフォルト設定 — 変更不可" : "Default setting — read-only"}
            </p>
          </div>
        </>
      )}

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
  );
}
