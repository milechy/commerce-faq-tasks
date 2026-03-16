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

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
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
 * 1リクエストの課金金額をセント単位（整数）で返す。
 *
 * 計算式: Math.ceil((LLMコスト[USD] + SERVER_COST_PER_REQUEST_USD) × MARGIN_MULTIPLIER × 100)
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

  const llmUSD   = _calculateLLMCostUSD(usage);
  const totalUSD = llmUSD + SERVER_COST_PER_REQUEST_USD;
  return Math.ceil(totalUSD * MARGIN_MULTIPLIER * 100);
}
