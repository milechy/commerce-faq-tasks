// admin-ui/src/components/avatar-wizard/AvatarWizard.tsx
// Phase64 タスク4: アバター生成ウィザード（6ステップ）

import { useState } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import {
  buildAvatarPrompt,
  AvatarType,
  Gender,
  AgeRange,
  Outfit,
  AnimalKind,
  AnimalVibe,
  RobotDesign,
  Composition,
  Expression,
  Background,
} from "../../lib/buildAvatarPrompt";

// ── スタイル定数 ──────────────────────────────────────────────────────────────

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

const CARD_BASE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "18px 14px",
  borderRadius: 14,
  border: "2px solid #1f2937",
  background: "rgba(15,23,42,0.9)",
  cursor: "pointer",
  minHeight: 80,
  minWidth: 44,
  fontSize: 14,
  color: "#e5e7eb",
  fontWeight: 600,
  transition: "border-color 0.15s, background 0.15s",
  userSelect: "none",
  textAlign: "center",
};

const CARD_SELECTED: React.CSSProperties = {
  ...CARD_BASE,
  border: "2px solid #3b82f6",
  background: "rgba(59,130,246,0.15)",
  color: "#93c5fd",
};

const BTN: React.CSSProperties = {
  padding: "12px 24px",
  borderRadius: 10,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
  minHeight: 44,
  minWidth: 44,
};

const BTN_GHOST: React.CSSProperties = {
  ...BTN,
  background: "rgba(255,255,255,0.08)",
  color: "#9ca3af",
};

const GRID_2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 12,
  marginTop: 16,
};

const GRID_3: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: 12,
  marginTop: 16,
};

const GRID_5: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
  gap: 12,
  marginTop: 16,
};

const STEP_LABEL: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
  marginBottom: 4,
  letterSpacing: "0.05em",
};

const TITLE: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  color: "#f9fafb",
  marginBottom: 20,
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#9ca3af",
  marginTop: 16,
  marginBottom: 8,
};

// ── 状態型 ────────────────────────────────────────────────────────────────────

interface WizardState {
  type: AvatarType | null;
  gender: Gender | null;
  age: AgeRange | null;
  outfit: Outfit | null;
  animalKind: AnimalKind | null;
  animalVibe: AnimalVibe | null;
  robotDesign: RobotDesign | null;
  composition: Composition | null;
  expression: Expression | null;
  background: Background | null;
  customBgColor: string;
}

const INITIAL: WizardState = {
  type: null, gender: null, age: null, outfit: null,
  animalKind: null, animalVibe: null, robotDesign: null,
  composition: null, expression: null, background: null,
  customBgColor: "#ffffff",
};

// ── 選択カード ────────────────────────────────────────────────────────────────

function SelectCard({
  label, emoji, selected, onClick,
}: { label: string; emoji: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      style={selected ? CARD_SELECTED : CARD_BASE}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = "#374151";
        }
      }}
      onMouseLeave={(e) => {
        if (!selected) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = "#1f2937";
        }
      }}
    >
      <span style={{ fontSize: 26 }}>{emoji}</span>
      <span>{label}</span>
    </button>
  );
}

// ── ステッパー ────────────────────────────────────────────────────────────────

function Stepper({ step, total }: { step: number; total: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 24 }}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            height: 4,
            flex: 1,
            borderRadius: 2,
            background: i < step ? "#3b82f6" : "rgba(255,255,255,0.1)",
            transition: "background 0.2s",
          }}
        />
      ))}
      <span style={{ fontSize: 12, color: "#6b7280", marginLeft: 4, whiteSpace: "nowrap" }}>
        {step}/{total}
      </span>
    </div>
  );
}

// ── ナビゲーションボタン ──────────────────────────────────────────────────────

function NavButtons({
  onBack, onNext, nextLabel = "次へ", nextDisabled = false,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 12, marginTop: 28, justifyContent: "flex-end" }}>
      {onBack && (
        <button type="button" style={BTN_GHOST} onClick={onBack}>← 戻る</button>
      )}
      <button type="button" style={{ ...BTN, opacity: nextDisabled ? 0.4 : 1 }} onClick={onNext} disabled={nextDisabled}>
        {nextLabel} →
      </button>
    </div>
  );
}

// ── メインウィザード ──────────────────────────────────────────────────────────

interface Props {
  tenantId: string;
  onComplete: (imageUrl: string) => void;
  onCancel: () => void;
}

export function AvatarWizard({ tenantId, onComplete, onCancel }: Props) {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(INITIAL);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const set = <K extends keyof WizardState>(key: K, val: WizardState[K]) =>
    setState((s) => ({ ...s, [key]: val }));

  const next = () => setStep((s) => s + 1);
  const back = () => setStep((s) => s - 1);

  // Step 2のスキップ判定: anime/3d は性別のみ
  const step2HasContent = state.type !== null;

  // ── Step 6: fal.ai 生成 ──────────────────────────────────────────────────

  async function handleGenerate() {
    if (!state.type || !state.composition || !state.expression || !state.background) return;
    setIsGenerating(true);
    setGenerateError(null);
    setGeneratedImages([]);
    setSelectedImage(null);

    try {
      const { prompt, negativePrompt } = buildAvatarPrompt({
        type: state.type,
        gender: state.gender ?? undefined,
        age: state.age ?? undefined,
        outfit: state.outfit ?? undefined,
        animalKind: state.animalKind ?? undefined,
        animalVibe: state.animalVibe ?? undefined,
        robotDesign: state.robotDesign ?? undefined,
        composition: state.composition,
        expression: state.expression,
        background: state.background,
        customBgColor: state.customBgColor,
      });

      const res = await authFetch(`${API_BASE}/v1/admin/avatar/fal/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, negativePrompt, numImages: 4 }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "生成に失敗しました");
      }

      const data = await res.json() as { images: string[] };
      setGeneratedImages(data.images ?? []);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "画像の生成に失敗しました。もう一度お試しください。");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleSelectAndSave() {
    if (!selectedImage) return;
    onComplete(selectedImage);
  }

  // ── Step 1: タイプ選択 ───────────────────────────────────────────────────

  const TYPE_OPTIONS: Array<{ value: AvatarType; label: string; emoji: string }> = [
    { value: "human",  label: "人間（リアル）",   emoji: "👤" },
    { value: "anime",  label: "アニメキャラ",      emoji: "🎭" },
    { value: "3d",     label: "3Dキャラ",          emoji: "🎮" },
    { value: "animal", label: "動物キャラ",         emoji: "🐾" },
    { value: "robot",  label: "ロボット/非人間",    emoji: "🤖" },
  ];

  // ── Step 2: スタイル（タイプ別） ─────────────────────────────────────────

  const GENDER_OPTIONS: Array<{ value: Gender; label: string; emoji: string }> = [
    { value: "male", label: "男性", emoji: "👨" },
    { value: "female", label: "女性", emoji: "👩" },
  ];

  const AGE_OPTIONS: Array<{ value: AgeRange; label: string; emoji: string }> = [
    { value: "20s", label: "20代", emoji: "🌱" },
    { value: "30s", label: "30代", emoji: "💼" },
    { value: "40s", label: "40代", emoji: "🏆" },
    { value: "50s+", label: "50代+", emoji: "🎯" },
  ];

  const OUTFIT_OPTIONS: Array<{ value: Outfit; label: string; emoji: string }> = [
    { value: "business_suit", label: "スーツ",     emoji: "👔" },
    { value: "casual",        label: "カジュアル", emoji: "👕" },
    { value: "white_coat",    label: "白衣",       emoji: "🥼" },
    { value: "uniform",       label: "制服",       emoji: "🎽" },
  ];

  const ANIMAL_KIND_OPTIONS: Array<{ value: AnimalKind; label: string; emoji: string }> = [
    { value: "dog",   label: "犬",   emoji: "🐕" },
    { value: "cat",   label: "猫",   emoji: "🐈" },
    { value: "bird",  label: "鳥",   emoji: "🐦" },
    { value: "bear",  label: "クマ", emoji: "🐻" },
    { value: "fox",   label: "キツネ", emoji: "🦊" },
    { value: "other", label: "その他", emoji: "🐾" },
  ];

  const ANIMAL_VIBE_OPTIONS: Array<{ value: AnimalVibe; label: string; emoji: string }> = [
    { value: "cute",  label: "可愛い",     emoji: "🥰" },
    { value: "cool",  label: "カッコいい", emoji: "😎" },
    { value: "silly", label: "おとぼけ",   emoji: "😆" },
  ];

  const ROBOT_DESIGN_OPTIONS: Array<{ value: RobotDesign; label: string; emoji: string }> = [
    { value: "simple", label: "シンプル", emoji: "⬜" },
    { value: "mecha",  label: "メカ",     emoji: "🦾" },
    { value: "scifi",  label: "SF",       emoji: "🛸" },
    { value: "cute",   label: "可愛い",   emoji: "🤖" },
  ];

  // ── Step 3: 構図 ─────────────────────────────────────────────────────────

  const COMP_OPTIONS: Array<{ value: Composition; label: string; emoji: string }> = [
    { value: "face_close", label: "顔アップ",   emoji: "🔍" },
    { value: "bust",       label: "胸から上",   emoji: "👆" },
    { value: "half_body",  label: "半身",       emoji: "🧍" },
    { value: "full_body",  label: "全身",       emoji: "🧍‍♀️" },
  ];

  // ── Step 4: 表情 ─────────────────────────────────────────────────────────

  const EXPR_OPTIONS: Array<{ value: Expression; label: string; emoji: string }> = [
    { value: "smile",   label: "笑顔",       emoji: "😊" },
    { value: "serious", label: "真剣",       emoji: "😐" },
    { value: "cool",    label: "クール",     emoji: "😎" },
    { value: "gentle",  label: "優しい",     emoji: "🥰" },
  ];

  // ── Step 5: 背景 ─────────────────────────────────────────────────────────

  const BG_OPTIONS: Array<{ value: Background; label: string; emoji: string }> = [
    { value: "simple", label: "シンプル（グレー）", emoji: "⬜" },
    { value: "office", label: "オフィス",            emoji: "🏢" },
    { value: "cafe",   label: "カフェ",              emoji: "☕" },
    { value: "custom", label: "カスタムカラー",      emoji: "🎨" },
  ];

  // ── Step 2 の「次へ」有効判定 ────────────────────────────────────────────

  const step2Valid = (() => {
    if (!state.type) return false;
    if (state.type === "human") return state.gender !== null;
    if (state.type === "animal") return state.animalKind !== null && state.animalVibe !== null;
    if (state.type === "robot") return state.robotDesign !== null;
    return true; // anime, 3d は任意
  })();

  // ── レンダリング ─────────────────────────────────────────────────────────

  const containerStyle: React.CSSProperties = {
    background: BG,
    minHeight: "100vh",
    padding: "32px 20px",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, sans-serif",
    boxSizing: "border-box",
  };

  const cardStyle: React.CSSProperties = {
    maxWidth: 600,
    margin: "0 auto",
    background: "rgba(15,23,42,0.95)",
    borderRadius: 20,
    border: "1px solid #1f2937",
    padding: "28px 28px 24px",
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={STEP_LABEL}>アバター作成ウィザード</div>
        <Stepper step={step} total={6} />

        {/* ── Step 1: タイプ ── */}
        {step === 1 && (
          <>
            <div style={TITLE}>どんなアバターにしますか？</div>
            <div style={GRID_5}>
              {TYPE_OPTIONS.map((opt) => (
                <SelectCard
                  key={opt.value}
                  label={opt.label}
                  emoji={opt.emoji}
                  selected={state.type === opt.value}
                  onClick={() => {
                    set("type", opt.value);
                    // タイプ変更時は関連フィールドをリセット
                    setState((s) => ({
                      ...s,
                      type: opt.value,
                      gender: null, age: null, outfit: null,
                      animalKind: null, animalVibe: null, robotDesign: null,
                    }));
                  }}
                />
              ))}
            </div>
            <NavButtons onBack={onCancel} onNext={next} nextDisabled={state.type === null} />
          </>
        )}

        {/* ── Step 2: スタイル（タイプ別） ── */}
        {step === 2 && step2HasContent && (
          <>
            <div style={TITLE}>スタイルを選んでください</div>

            {/* 人間 */}
            {state.type === "human" && (
              <>
                <div style={SECTION_LABEL}>性別 *</div>
                <div style={GRID_2}>
                  {GENDER_OPTIONS.map((opt) => (
                    <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                      selected={state.gender === opt.value} onClick={() => set("gender", opt.value)} />
                  ))}
                </div>
                <div style={SECTION_LABEL}>年代（任意）</div>
                <div style={GRID_2}>
                  {AGE_OPTIONS.map((opt) => (
                    <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                      selected={state.age === opt.value} onClick={() => set("age", opt.value)} />
                  ))}
                </div>
                <div style={SECTION_LABEL}>服装（任意）</div>
                <div style={GRID_2}>
                  {OUTFIT_OPTIONS.map((opt) => (
                    <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                      selected={state.outfit === opt.value} onClick={() => set("outfit", opt.value)} />
                  ))}
                </div>
              </>
            )}

            {/* アニメ / 3D */}
            {(state.type === "anime" || state.type === "3d") && (
              <>
                <div style={SECTION_LABEL}>性別（任意）</div>
                <div style={GRID_2}>
                  {GENDER_OPTIONS.map((opt) => (
                    <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                      selected={state.gender === opt.value} onClick={() => set("gender", opt.value)} />
                  ))}
                </div>
              </>
            )}

            {/* 動物 */}
            {state.type === "animal" && (
              <>
                <div style={SECTION_LABEL}>動物の種類 *</div>
                <div style={GRID_3}>
                  {ANIMAL_KIND_OPTIONS.map((opt) => (
                    <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                      selected={state.animalKind === opt.value} onClick={() => set("animalKind", opt.value)} />
                  ))}
                </div>
                <div style={SECTION_LABEL}>雰囲気 *</div>
                <div style={GRID_3}>
                  {ANIMAL_VIBE_OPTIONS.map((opt) => (
                    <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                      selected={state.animalVibe === opt.value} onClick={() => set("animalVibe", opt.value)} />
                  ))}
                </div>
              </>
            )}

            {/* ロボット */}
            {state.type === "robot" && (
              <>
                <div style={SECTION_LABEL}>デザイン *</div>
                <div style={GRID_2}>
                  {ROBOT_DESIGN_OPTIONS.map((opt) => (
                    <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                      selected={state.robotDesign === opt.value} onClick={() => set("robotDesign", opt.value)} />
                  ))}
                </div>
              </>
            )}

            <NavButtons onBack={back} onNext={next} nextDisabled={!step2Valid} />
          </>
        )}

        {/* ── Step 3: 構図 ── */}
        {step === 3 && (
          <>
            <div style={TITLE}>構図を選んでください</div>
            <div style={GRID_2}>
              {COMP_OPTIONS.map((opt) => (
                <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                  selected={state.composition === opt.value} onClick={() => set("composition", opt.value)} />
              ))}
            </div>
            <NavButtons onBack={back} onNext={next} nextDisabled={state.composition === null} />
          </>
        )}

        {/* ── Step 4: 表情 ── */}
        {step === 4 && (
          <>
            <div style={TITLE}>表情を選んでください</div>
            <div style={GRID_2}>
              {EXPR_OPTIONS.map((opt) => (
                <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                  selected={state.expression === opt.value} onClick={() => set("expression", opt.value)} />
              ))}
            </div>
            <NavButtons onBack={back} onNext={next} nextDisabled={state.expression === null} />
          </>
        )}

        {/* ── Step 5: 背景 ── */}
        {step === 5 && (
          <>
            <div style={TITLE}>背景を選んでください</div>
            <div style={GRID_2}>
              {BG_OPTIONS.map((opt) => (
                <SelectCard key={opt.value} label={opt.label} emoji={opt.emoji}
                  selected={state.background === opt.value} onClick={() => set("background", opt.value)} />
              ))}
            </div>
            {state.background === "custom" && (
              <div style={{ marginTop: 16 }}>
                <label style={{ fontSize: 13, color: "#9ca3af", display: "block", marginBottom: 8 }}>
                  背景カラー
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <input
                    type="color"
                    value={state.customBgColor}
                    onChange={(e) => set("customBgColor", e.target.value)}
                    style={{ width: 48, height: 48, borderRadius: 8, border: "none", cursor: "pointer" }}
                  />
                  <span style={{ color: "#9ca3af", fontSize: 14 }}>{state.customBgColor}</span>
                </div>
              </div>
            )}
            <NavButtons onBack={back} onNext={next} nextDisabled={state.background === null} />
          </>
        )}

        {/* ── Step 6: 生成 ── */}
        {step === 6 && (
          <>
            <div style={TITLE}>アバターを生成します</div>

            {/* 選択内容サマリ */}
            <div style={{
              background: "rgba(30,41,59,0.6)", borderRadius: 10, padding: "14px 16px",
              marginBottom: 20, fontSize: 13, color: "#9ca3af", lineHeight: 1.8,
            }}>
              <div>タイプ: <span style={{ color: "#e5e7eb" }}>
                {TYPE_OPTIONS.find((o) => o.value === state.type)?.emoji}{" "}
                {TYPE_OPTIONS.find((o) => o.value === state.type)?.label}
              </span></div>
              <div>構図: <span style={{ color: "#e5e7eb" }}>
                {COMP_OPTIONS.find((o) => o.value === state.composition)?.label}
              </span></div>
              <div>表情: <span style={{ color: "#e5e7eb" }}>
                {EXPR_OPTIONS.find((o) => o.value === state.expression)?.label}
              </span></div>
              <div>背景: <span style={{ color: "#e5e7eb" }}>
                {BG_OPTIONS.find((o) => o.value === state.background)?.label}
              </span></div>
            </div>

            {/* 生成ボタン */}
            {generatedImages.length === 0 && !isGenerating && (
              <button
                type="button"
                style={{ ...BTN, width: "100%", fontSize: 16 }}
                onClick={handleGenerate}
              >
                ✨ アバターを生成する（4枚）
              </button>
            )}

            {/* ローディング */}
            {isGenerating && (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <div style={{
                  width: 48, height: 48, border: "4px solid rgba(255,255,255,0.1)",
                  borderTop: "4px solid #3b82f6", borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                  margin: "0 auto 16px",
                }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                <div style={{ color: "#9ca3af", fontSize: 14 }}>アバターを作成中です...</div>
                <div style={{ color: "#6b7280", fontSize: 12, marginTop: 6 }}>10〜20秒ほどかかります</div>
              </div>
            )}

            {/* エラー */}
            {generateError && (
              <div style={{
                background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.3)",
                borderRadius: 10, padding: "12px 16px", color: "#fca5a5", fontSize: 14, marginBottom: 16,
              }}>
                {generateError}
                <button
                  type="button"
                  style={{ ...BTN, marginTop: 12, width: "100%", background: "rgba(220,38,38,0.6)" }}
                  onClick={handleGenerate}
                >
                  もう一度試す
                </button>
              </div>
            )}

            {/* 生成結果グリッド */}
            {generatedImages.length > 0 && (
              <>
                <div style={{ fontSize: 14, color: "#9ca3af", marginBottom: 12 }}>
                  お気に入りの1枚を選んでください
                </div>
                <div style={{
                  display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 20,
                }}>
                  {generatedImages.map((url, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setSelectedImage(url)}
                      style={{
                        padding: 0, border: "none", cursor: "pointer", borderRadius: 12,
                        outline: selectedImage === url ? "3px solid #3b82f6" : "2px solid transparent",
                        outlineOffset: 2,
                        overflow: "hidden",
                        background: "none",
                        transition: "outline 0.15s",
                      }}
                    >
                      <img
                        src={url}
                        alt={`生成画像 ${i + 1}`}
                        style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover", display: "block" }}
                      />
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <button type="button" style={BTN_GHOST} onClick={handleGenerate}>
                    再生成
                  </button>
                  <button
                    type="button"
                    style={{ ...BTN, flex: 1, opacity: selectedImage ? 1 : 0.4 }}
                    onClick={handleSelectAndSave}
                    disabled={!selectedImage}
                  >
                    この画像を使う ✓
                  </button>
                </div>
              </>
            )}

            {!isGenerating && generatedImages.length === 0 && !generateError && (
              <div style={{ marginTop: 16 }}>
                <button type="button" style={BTN_GHOST} onClick={back}>← 戻る</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
