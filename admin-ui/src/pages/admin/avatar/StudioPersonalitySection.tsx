// admin-ui/src/pages/admin/avatar/StudioPersonalitySection.tsx
// studio.tsx から抽出 — 4. パーソナリティセクション（機能変更なし）

import { useLang } from "../../../i18n/LangContext";
import { SECTION_STYLE, LABEL_STYLE, TEXTAREA_STYLE, BTN_PRIMARY } from "./types";

export function StudioPersonalitySection({
  isDefault,
  isSuperAdmin,
  promptRules,
  setPromptRules,
  generatingPrompt,
  handleGeneratePrompt,
  agentPrompt,
  agentIdlePrompt,
  behaviorDescription,
  setBehaviorDescription,
  emotionTags,
}: {
  isDefault: boolean;
  isSuperAdmin: boolean;
  promptRules: string;
  setPromptRules: (v: string) => void;
  generatingPrompt: boolean;
  handleGeneratePrompt: () => Promise<void>;
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

      {/* personality_prompt はテキストの回答生成経路に配線されていない（表情・声にのみ影響）ため、
          「編集できるのに反映されない」という誤認を避けるべく編集欄は表示せず、正しい設定先を案内する。
          Asana: https://app.asana.com/1/817733952351708/project/1213607637045514/task/1218088953961618 */}
      <div style={{ marginTop: 16 }}>
        <label style={LABEL_STYLE}>
          {lang === "ja" ? "口調・人格の設定について" : "About tone & persona settings"}
        </label>
        <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "4px 0 0", lineHeight: 1.6 }}>
          {isSuperAdmin
            ? (lang === "ja"
                ? "アバターの応答の口調・人格は「テナント詳細 → 設定」の「システムプロンプト（AIへの指示）」で設定してください。ここでの表情・所作用の設定とは別の場所で管理されています。"
                : "The avatar's response tone and persona are configured under Tenant Detail → Settings → \"System Prompt (Instructions for AI)\". This is managed separately from the expression/motion settings on this page.")
            : (lang === "ja"
                ? "アバターの応答の口調・人格のご希望は、担当者までお問い合わせください。"
                : "For tone/persona requests for the avatar's responses, please contact your account manager.")}
        </p>
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
