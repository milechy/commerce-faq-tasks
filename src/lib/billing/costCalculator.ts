// src/lib/billing/costCalculator.ts
// Phase32: コスト計算（金額はセント単位の整数で管理）

export type ModelKey = 'groq-8b' | 'groq-70b' | 'openai-embedding' | 'gemini-2.5-flash' | 'perplexity-sonar-pro' | 'gpt-oss-20b' | 'gpt-oss-120b';

export interface ModelCost {
  /** USD per 1M tokens */
  inputPerMillion: number;
  /** USD per 1M tokens */
  outputPerMillion: number;
}

/** LLM単価テーブル（USD / 1M tokens） */
export const LLM_COSTS: Record<ModelKey, ModelCost> = {
  'groq-8b':           { inputPerMillion: 0.05,  outputPerMillion: 0.08 },
  'groq-70b':          { inputPerMillion: 0.59,  outputPerMillion: 0.79 },
  'openai-embedding':  { inputPerMillion: 0.02,  outputPerMillion: 0.0  },
  'gemini-2.5-flash':     { inputPerMillion: 0.075, outputPerMillion: 0.30  },
  'perplexity-sonar-pro': { inputPerMillion: 3.0,   outputPerMillion: 15.0  },
  // Groq GPT-OSS（マルチステップ planner 用、2026 値下げ後の公式単価）
  'gpt-oss-20b':          { inputPerMillion: 0.075, outputPerMillion: 0.30  },
  'gpt-oss-120b':         { inputPerMillion: 0.15,  outputPerMillion: 0.60  },
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
const ANAM_COST_PER_MINUTE_USD = 0.16;

/**
 * Phase42: Anamセッションコストをセント単位（整数）で返す。
 * $0.16/分。切り上げ。
 */
function calculateAnamSessionCostCents(sessionSeconds: number): number {
  if (sessionSeconds < 0) throw new Error(`Invalid sessionSeconds: ${sessionSeconds}`);
  if (sessionSeconds === 0) return 0;
  const minutes = sessionSeconds / 60;
  return Math.ceil(minutes * ANAM_COST_PER_MINUTE_USD * 100);
}

/** Phase41: DALL-E 3 画像生成単価: $0.04/枚 */
export const IMAGE_GENERATION_COST_USD = 0.04;

/**
 * Phase3 (Sai接続ブリッジ): GUI自動化エージェント1ステップあたりの原価見積もり(USD)。
 * PoC時点ではClaude Opus(推論) + UI-TARS(grounding, OpenRouter経由)の実測コストが
 * タスクの複雑さで大きく変動するため未確定(要検証)。env override で運用しながら調整する。
 */
export const SAI_AGENT_COST_PER_STEP_USD = Number(process.env.SAI_AGENT_COST_PER_STEP_USD ?? '0.05') || 0.05;

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
  /** Phase42: Anamセッション時間（秒） */
  anam_session_seconds?: number;
  /**
   * Subtask 3: 同一リクエスト内の追加 LLM 呼び出し（マルチステップ planner 等）を
   * モデル別の実レートで本行のコストに合算する。usage_logs は「1行=1リクエスト」
   * （Stripe quantity=COUNT(*)）のため別行は作らず、本行の cost に内包する。
   * 各要素はそれぞれ自分の model 単価で計算され、サーバーコストは加算しない。
   */
  extraLlmUsages?: Array<{ model: string; inputTokens: number; outputTokens: number }>;
  /** Phase3 (Sai接続ブリッジ): Agent Sが実行したステップ数（社内原価集計のみ、テナント請求には使わない） */
  saiAgentSteps?: number;
}

/** Subtask 3: 追加 LLM 呼び出し（planner 等）の LLM コストを USD 合算する（モデル別実レート）。 */
function _sumExtraLlmUsd(extras?: UsageRecord['extraLlmUsages']): number {
  if (!extras || extras.length === 0) return 0;
  return extras.reduce(
    (sum, e) =>
      sum +
      _calculateLLMCostUSD({
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
      }),
    0,
  );
}

/**
 * モデル名を ModelKey に正規化する。
 * 不明なモデルは undefined を返す。
 */
export function normalizeModelKey(model: string): ModelKey | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('embedding')) return 'openai-embedding';
  if (lower.includes('gemini')) return 'gemini-2.5-flash';
  if (lower.includes('perplexity')) return 'perplexity-sonar-pro';
  // gpt-oss は 70b/8b の汎用判定より先に評価する（"120b" は "20b" を部分文字列に含むため 120b を先に）。
  // env override (LLM_MODEL_20B/120B) で provider prefix 等が変わっても拾えるよう gpt-oss 系を広めに判定。
  if (lower.includes('gpt-oss')) {
    return lower.includes('120') ? 'gpt-oss-120b' : 'gpt-oss-20b';
  }
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
  const extraUSD = _sumExtraLlmUsd(usage.extraLlmUsages);
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && extraUSD === 0) return 0;

  return Math.ceil((_calculateLLMCostUSD(usage) + extraUSD) * 100);
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
  // 本行の LLM コスト + 同一リクエスト内の追加 LLM 呼び出し（planner 等）をモデル別実レートで合算。
  const llmUSD   = _calculateLLMCostUSD(usage) + _sumExtraLlmUsd(usage.extraLlmUsages);
  const ttsUSD   = (usage.ttsTextBytes  ?? 0) * FISH_AUDIO_COST_PER_BYTE_USD;
  const avtrUSD  = (usage.avatarCredits ?? 0) * LEMONSLICE_COST_PER_CREDIT_USD;
  const imgUSD   = (usage.imageCount    ?? 0) * IMAGE_GENERATION_COST_USD;
  const anamUSD  = (usage.anam_session_seconds ?? 0) > 0
    ? calculateAnamSessionCostCents(usage.anam_session_seconds!) / 100
    : 0;
  const saiUSD   = (usage.saiAgentSteps ?? 0) * SAI_AGENT_COST_PER_STEP_USD;
  const totalUSD = llmUSD + SERVER_COST_PER_REQUEST_USD + ttsUSD + avtrUSD + imgUSD + anamUSD + saiUSD;
  return Math.ceil(totalUSD * margin * 100);
}
