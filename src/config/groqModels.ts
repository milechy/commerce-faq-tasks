// src/config/groqModels.ts
// Groq / gpt-oss モデル ID の単一の正典（散在ハードコードの集約先）。
//
// 目的:
//   1. 集約 — モデル ID をコード全体に散らさず、ここだけを更新すれば差し替えられる。
//   2. EOL 検知 — Groq が decommission したモデルを KNOWN_DEPRECATED に列挙し、
//      `SCRIPTS/check-groq-models.sh` が src/ にその文字列が混入したら CI を落とす。
//
// 追加・変更時のルール:
//   - 新モデル採用: ACTIVE に定数を足し、call site をその定数経由に。
//   - モデル廃止: Groq の deprecation 告知が出たら KNOWN_DEPRECATED に id を追記。
//     検知層が src/ 内の残存使用を洗い出すので、移行漏れを防げる。

/** 現在アクティブな Groq チャットモデル（実機で呼び出している実 ID）。値は実 ID と完全一致させること。 */
export const GROQ_INSTANT_8B = 'llama-3.1-8b-instant';
export const GROQ_VERSATILE_70B = 'llama-3.3-70b-versatile';
export const GROQ_COMPOUND = 'groq/compound';
export const GROQ_COMPOUND_MINI = 'groq/compound-mini';

/** gpt-oss（Groq 経由）— アーキテクチャ上の 20B / 120B。 */
export const GPT_OSS_20B = 'openai/gpt-oss-20b';
export const GPT_OSS_120B = 'openai/gpt-oss-120b';

export type GroqModelStatus = 'active' | 'deprecated';

export interface GroqModelEntry {
  id: string;
  /** 用途の目安。集約後の選定で参照する。 */
  tier: 'instant' | 'versatile' | 'compound' | 'compound-mini' | 'oss-20b' | 'oss-120b';
  status: GroqModelStatus;
}

/** アクティブモデルのレジストリ（COST マップ・テスト・検知層が参照する単一の真実）。 */
export const ACTIVE_GROQ_MODELS: readonly GroqModelEntry[] = [
  { id: GROQ_INSTANT_8B, tier: 'instant', status: 'active' },
  { id: GROQ_VERSATILE_70B, tier: 'versatile', status: 'active' },
  { id: GROQ_COMPOUND, tier: 'compound', status: 'active' },
  { id: GROQ_COMPOUND_MINI, tier: 'compound-mini', status: 'active' },
  { id: GPT_OSS_20B, tier: 'oss-20b', status: 'active' },
  { id: GPT_OSS_120B, tier: 'oss-120b', status: 'active' },
] as const;

export const ACTIVE_GROQ_MODEL_IDS: readonly string[] = ACTIVE_GROQ_MODELS.map((m) => m.id);

/**
 * Groq が decommission 済み / 廃止予定として告知したモデル ID。
 * ここに載った ID が src/ (非 test) に残っていれば EOL 検知層が CI を落とす。
 * 出典: Groq deprecations (https://console.groq.com/docs/deprecations)。
 */
export const KNOWN_DEPRECATED_GROQ_MODELS: readonly string[] = [
  'llama-3.1-70b-versatile', // → llama-3.3-70b-versatile に移行済み
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma-7b-it',
  'gemma2-9b-it',
  'llama-3.2-1b-preview',
  'llama-3.2-3b-preview',
  'llama-3.2-11b-vision-preview',
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-text-preview',
  'llama-3.2-90b-text-preview',
] as const;

const DEPRECATED_SET = new Set(KNOWN_DEPRECATED_GROQ_MODELS);

/** 与えられたモデル ID が Groq の既知 EOL リストに含まれるか。 */
export function isDeprecatedGroqModel(model: string): boolean {
  return DEPRECATED_SET.has(model);
}

/**
 * モデル ID がアクティブであることを保証する。EOL モデルなら例外を投げる。
 * 起動時 / 設定読込時の fail-fast 用。
 */
export function assertActiveGroqModel(model: string): void {
  if (isDeprecatedGroqModel(model)) {
    throw new Error(
      `[groqModels] decommissioned Groq model "${model}" is in use. ` +
        `Migrate to an ACTIVE_GROQ_MODELS entry (see src/config/groqModels.ts).`,
    );
  }
}

/**
 * モデルが 404 / model_not_found エラーを返した際のフォールバックチェーン。
 *
 * キー: 優先モデルの ID
 * 値: 退避先モデルの ID（カタログの ACTIVE_GROQ_MODELS 内のみ許可）
 *
 * 設計方針:
 *   - 高性能モデルから汎用モデルへ段階的に下げる。
 *   - 最後は必ず llama-3.1-8b-instant（最小/最安）。
 *   - 120B 系は compound に退避（ANTI-SLOP: 120B は複雑クエリ/safety のみ使用）。
 *   - チェーンは最大 2 段。無限ループ防止のため resolve 時に検証する。
 */
export const GROQ_FALLBACK_CHAIN: Readonly<Record<string, string>> = {
  // gpt-oss 系: EOL 通知前の緊急退避
  [GPT_OSS_120B]: GPT_OSS_20B,
  [GPT_OSS_20B]: GROQ_VERSATILE_70B,
  // compound 系
  [GROQ_COMPOUND]: GROQ_COMPOUND_MINI,
  [GROQ_COMPOUND_MINI]: GROQ_VERSATILE_70B,
  // versatile → instant
  [GROQ_VERSATILE_70B]: GROQ_INSTANT_8B,
  // instant: これ以上退避先なし（チェーン終端）
};

/**
 * 指定モデルのフォールバック先を返す。
 *
 * @returns フォールバック先モデル ID。チェーン終端の場合は null。
 */
export function getFallbackGroqModel(model: string): string | null {
  return GROQ_FALLBACK_CHAIN[model] ?? null;
}
