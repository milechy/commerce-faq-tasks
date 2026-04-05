// src/lib/billing/costCalculator.ts
// Phase32: コスト計算（金額はセント単位の整数で管理）

export type ModelKey = 'groq-8b' | 'groq-70b' | 'openai-embedding';

export interface ModelCost {
  /** USD per 1M tokens */
  inputPerMillion: number;
  /** USD per 1M tokens */
  outputPerMillion: number;
}

/** LLM単価テーブル（USD / 1M tokens） */
export const LLM_COSTS: Record<ModelKey, ModelCost> = {
  'groq-8b':          { inputPerMillion: 0.05,  outputPerMillion: 0.08 },
  'groq-70b':         { inputPerMillion: 0.59,  outputPerMillion: 0.79 },
  'openai-embedding': { inputPerMillion: 0.02,  outputPerMillion: 0.0  },
};

/** サーバーコスト: $0.0001 / リクエスト（VPS按分） */
export const SERVER_COST_PER_REQUEST_USD = 0.0001;

/** マージン倍率（環境変数 MARGIN_RATE で変更可能、デフォルト5） */
export const MARGIN_MULTIPLIER = Number(process.env.MARGIN_RATE ?? '5') || 5;

/**
 * エンドユーザーが直接使う機能（マージン × MARGIN_RATE を適用）。
 * それ以外の管理者・運用向け機能は原価のみ（× 1）。
 */
export const END_USER_FEATURES: ReadonlySet<string> = new Set(['chat', 'avatar', 'voice']);

/** Phase40: Fish Audio TTS単価: $15.00 / 1M UTF-8バイト */
export const FISH_AUDIO_COST_PER_BYTE_USD = 15.0 / 1_000_000;

/** Phase40: Lemonslice単価: $7.00 / 1000クレジット */
export const LEMONSLICE_COST_PER_CREDIT_USD = 7.0 / 1_000;

/** Phase42: Anam.ai単価: $0.16/分 (Starterプラン) */
export const ANAM_COST_PER_MINUTE_USD = 0.16;

/**
 * Phase42: Anamセッションコストをセント単位（整数）で返す。
 * $0.16/分。切り上げ。
 */
export function calculateAnamSessionCostCents(sessionSeconds: number): number {
  if (sessionSeconds < 0) throw new Error(`Invalid sessionSeconds: ${sessionSeconds}`);
  if (sessionSeconds === 0) return 0;
  const minutes = sessionSeconds / 60;
  return Math.ceil(minutes * ANAM_COST_PER_MINUTE_USD * 100);
}

/** Phase41: DALL-E 3 画像生成単価: $0.04/枚 */
export const IMAGE_GENERATION_COST_USD = 0.04;

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** マージン倍率の上書き（省略時は MARGIN_MULTIPLIER を使用） */
  marginOverride?: number;
  /** Phase40: Fish Audio TTSに送ったテキストのUTF-8バイト数 */
  ttsTextBytes?: number;
  /** Phase40: Lemonsliceのクレジット消費量 */
  avatarCredits?: number;
  /** Phase40: LiveKitセッション時間（ミリ秒） */
  avatarSessionMs?: number;
  /**
   * Phase53: 使用機能名（END_USER_FEATURES に含まれる場合のみ MARGIN_RATE 適用）。
   * 省略時は後方互換のため MARGIN_MULTIPLIER を適用する。
   */
  featureUsed?: string;
  /** Phase53: 生成画像枚数（DALL-E / Leonardo 等）。原価のみ。 */
  imageCount?: number;
}

/**
 * モデル名を ModelKey に正規化する。
 * 不明なモデルは undefined を返す。
 */
export function normalizeModelKey(model: string): ModelKey | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('embedding')) return 'openai-embedding';
  if (lower.includes('70b') || lower.includes('mixtral')) return 'groq-70b';
  if (
    lower.includes('8b') ||
    lower.includes('gemma') ||
    lower.includes('llama') ||
    lower.includes('groq-8b')
  ) {
    return 'groq-8b';
  }
  return undefined;
}

/**
 * LLMトークン使用量のUSDコストを返す（内部ヘルパー、丸めなし）。
 */
function _calculateLLMCostUSD(usage: UsageRecord): number {
  const modelKey = normalizeModelKey(usage.model);
  if (!modelKey) return 0;

  const costs = LLM_COSTS[modelKey];
  const inputCost  = (usage.inputTokens  * costs.inputPerMillion)  / 1_000_000;
  const outputCost = (usage.outputTokens * costs.outputPerMillion) / 1_000_000;
  return inputCost + outputCost;
}

/**
 * LLMトークン使用量のコストをセント単位（整数）で返す。
 * 切り上げ。ゼロトークンは 0 を返す。
 *
 * @throws inputTokens / outputTokens が負の場合
 */
export function calculateLLMCostCents(usage: UsageRecord): number {
  if (usage.inputTokens < 0 || usage.outputTokens < 0) {
    throw new Error(
      `Invalid token counts: input=${usage.inputTokens}, output=${usage.outputTokens}`
    );
  }
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return 0;

  return Math.ceil(_calculateLLMCostUSD(usage) * 100);
}

/**
 * Phase40: Fish Audio TTS コストをセント単位（整数）で返す。
 * $15.00 / 1M UTF-8バイト。切り上げ。
 */
export function calculateTTSCostCents(ttsTextBytes: number): number {
  if (ttsTextBytes < 0) throw new Error(`Invalid ttsTextBytes: ${ttsTextBytes}`);
  if (ttsTextBytes === 0) return 0;
  return Math.ceil(ttsTextBytes * FISH_AUDIO_COST_PER_BYTE_USD * 100);
}

/**
 * Phase40: Lemonslice Avatar コストをセント単位（整数）で返す。
 * $7.00 / 1000クレジット。切り上げ。
 */
export function calculateAvatarCostCents(credits: number): number {
  if (credits < 0) throw new Error(`Invalid credits: ${credits}`);
  if (credits === 0) return 0;
  return Math.ceil(credits * LEMONSLICE_COST_PER_CREDIT_USD * 100);
}

/**
 * 1リクエストの課金金額をセント単位（整数）で返す。
 *
 * - エンドユーザー向け機能（chat/avatar/voice）: MARGIN_MULTIPLIER 適用
 * - 管理者・運用向け機能: × 1（原価のみ）
 * - featureUsed 未指定時は後方互換のため MARGIN_MULTIPLIER を適用
 *
 * 中間丸めを避けるため USD のまま合算してから最後に変換する。
 *
 * @throws inputTokens / outputTokens が負の場合
 */
export function calculateBillingAmountCents(usage: UsageRecord): number {
  if (usage.inputTokens < 0 || usage.outputTokens < 0) {
    throw new Error(
      `Invalid token counts: input=${usage.inputTokens}, output=${usage.outputTokens}`
    );
  }

  const isEndUser = usage.featureUsed === undefined || END_USER_FEATURES.has(usage.featureUsed);
  const margin   = usage.marginOverride ?? (isEndUser ? MARGIN_MULTIPLIER : 1);
  const llmUSD   = _calculateLLMCostUSD(usage);
  const ttsUSD   = (usage.ttsTextBytes  ?? 0) * FISH_AUDIO_COST_PER_BYTE_USD;
  const avtrUSD  = (usage.avatarCredits ?? 0) * LEMONSLICE_COST_PER_CREDIT_USD;
  const imgUSD   = (usage.imageCount    ?? 0) * IMAGE_GENERATION_COST_USD;
  const totalUSD = llmUSD + SERVER_COST_PER_REQUEST_USD + ttsUSD + avtrUSD + imgUSD;
  return Math.ceil(totalUSD * margin * 100);
}
