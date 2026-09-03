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
 * GID 1217972417593917 [H-10] 2026-08-30: 「原価をテナントに見せるかどうか」は、
 * このMARGIN_MULTIPLIERの値ではなく、面(画面)ごとの目的で決める方針が確定した。
 *
 *   - admin-ui/src/pages/admin/billing/BillingSummaryCards.tsx の「LLMコスト（原価）」、
 *     同 index.tsx の「コスト内訳（原価・USD概算）」→ 表示する。課金画面は費用の
 *     事前明示が目的の画面なので、原価の開示はその目的に沿う。請求見積り
 *     (billing_estimate_jpy)と原価が同じ画面に並ぶため、このMARGIN_MULTIPLIER
 *     が逆算できてしまう点は承知の上での判断。
 *   - src/api/admin/tenants/analyticsSummaryRoutes.ts の llm_usage(PostHog原価)
 *     → super_admin限定で非表示(PR #1062)。あちらはテナント分析が目的の画面で、
 *     原価はそこに紛れ込んでいただけ。
 *
 * この2面が「片方はsuper_admin限定、片方は全公開」に見えるのは不整合ではなく
 * 意図的な差。どちらかに揃えて直すと、課金画面側なら費用の事前明示が壊れ、
 * 分析タブ側ならこのMARGIN_MULTIPLIER(粗利率)が漏れる。揃えないこと。
 */

/**
 * エンドユーザーが直接使う機能（マージン × MARGIN_RATE を適用）。
 * それ以外の管理者・運用向け機能は原価のみ（× 1）。
 *
 * agent_search([A2A-1a] 外部エージェント連携API)は、テナントが従量課金で
 * 契約する対外向けAPIであり運用ツールではないため、chat/avatar/voiceと同格。
 * 'chat' から分離した経緯は usageTracker.ts の FeatureUsed コメント参照。
 */
export const END_USER_FEATURES: ReadonlySet<string> = new Set(['chat', 'avatar', 'voice', 'agent_search']);

/**
 * GID 1216944003337186: usage_logs の行として記録はする（cost_total_centsで原価は可視化する）が、
 * stripeSync.ts の集計（Stripe請求数量 billedQuantity）からは除外する機能。
 * usage_logs.billable カラムで制御する（デフォルトtrue、ここに含まれる機能のみfalseになる）。
 *
 * - admin_tuning / admin_ai_assist / admin_engagement_suggest / admin_option_estimator:
 *   いずれもmooores社内の運用・チューニングツールで、テナントの直接操作によるリクエストではない。
 *   請求リクエスト数を水増ししないよう非課金とする。
 * - sai_agent: テナント請求は既に chargeOneOffJpy（代行作業完了時の単発JPY請求、
 *   options/routes.ts の /complete エンドポイント）で完結している。ここでも
 *   billedQuantityのCOUNT(*)に含めると二重計上になるため非課金とする。
 */
export const NON_BILLABLE_FEATURES: ReadonlySet<string> = new Set([
  'admin_tuning',
  'admin_ai_assist',
  'admin_engagement_suggest',
  'admin_option_estimator',
  'sai_agent',
]);

/** Phase40: Fish Audio TTS単価: $15.00 / 1M UTF-8バイト */
export const FISH_AUDIO_COST_PER_BYTE_USD = 15.0 / 1_000_000;

/**
 * GID 1217083837550852: Fish Audio TTSはモデルによって単価が異なる
 * （s2.1-pro-free は無料期間中のみ $0）。実際に使ったモデル名は
 * trackUsage 呼び出し元（fishTtsRoutes.ts / agent.py）が申告する。
 * 未知のモデル名や省略時は既存の FISH_AUDIO_COST_PER_BYTE_USD（有料単価）にフォールバックする。
 */
const FISH_AUDIO_MODEL_COST_PER_BYTE_USD: Record<string, number> = {
  's2.1-pro-free': 0,
  's2.1-pro': FISH_AUDIO_COST_PER_BYTE_USD,
  's2-pro': FISH_AUDIO_COST_PER_BYTE_USD,
  's1': FISH_AUDIO_COST_PER_BYTE_USD,
};

/** 既知のFish Audio TTSモデルID一覧（外部境界での allowlist 検証に使う単一の情報源） */
export const FISH_AUDIO_KNOWN_TTS_MODELS: readonly string[] = Object.keys(FISH_AUDIO_MODEL_COST_PER_BYTE_USD);

export function fishTtsCostPerByteUsd(model?: string): number {
  if (!model) return FISH_AUDIO_COST_PER_BYTE_USD;
  return FISH_AUDIO_MODEL_COST_PER_BYTE_USD[model] ?? FISH_AUDIO_COST_PER_BYTE_USD;
}

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

/**
 * GID 1216944049264977: 未計測だった外部API課金経路の単価定数群。
 * いずれも公式の確定単価が確認できていないため暫定値(要検証)。env override で運用しながら調整する。
 */

/**
 * Qwen2.5-VL (Dashscope International, qwen-vl-max-latest) OCR 1ページあたりの原価見積もり(USD)。
 * VLMは画像解像度でトークン数が可変のため正確な単価が未確認(要検証)。
 */
export const QWEN_OCR_COST_PER_PAGE_USD = Number(process.env.QWEN_OCR_COST_PER_PAGE_USD ?? '0.01') || 0.01;

/**
 * Fish Audio ASR (Transcribe-1) 1リクエストあたりの原価見積もり(USD)。
 * 音声長(秒)を計測できない呼び出し元向けのフォールバック単価(要検証)。
 * 音声長を計測できる場合は FISH_ASR_COST_PER_HOUR_USD（公式の実単価）を使う。
 */
export const FISH_ASR_COST_PER_REQUEST_USD = Number(process.env.FISH_ASR_COST_PER_REQUEST_USD ?? '0.01') || 0.01;

/**
 * GID 1217083837550916: Fish Audio ASR (Transcribe-1) の公式単価: $0.36 / audio hour。
 * 音声長(秒)を計測できる場合はこちらを使う（FISH_ASR_COST_PER_REQUEST_USD より正確）。
 */
export const FISH_ASR_COST_PER_HOUR_USD = Number(process.env.FISH_ASR_COST_PER_HOUR_USD ?? '0.36') || 0.36;

/**
 * GID 1217084040137242: Fish Audio Voice Design (voice-design-1) の公式単価:
 * $0.01 / 成功リクエスト。候補数(n)によらず1リクエスト固定。失敗リクエストは非課金。
 */
export const VOICE_DESIGN_COST_PER_REQUEST_USD = Number(process.env.VOICE_DESIGN_COST_PER_REQUEST_USD ?? '0.01') || 0.01;

/**
 * Freepik Magnific AI アップスケール1回あたりの原価見積もり(USD)。
 * 出力解像度・アップスケール倍率(2x〜16x)で価格が変動する従量制のため、
 * 本実装のデフォルト設定(scaleFactor=2, style=portrait)相当の概算値(要検証)。
 */
export const MAGNIFIC_UPSCALE_COST_USD = Number(process.env.MAGNIFIC_UPSCALE_COST_USD ?? '0.08') || 0.08;

/**
 * fal.ai Flux 2 Pro (flux-pro/v1.1) 1枚あたりの原価見積もり(USD)。
 * 公式単価は$0.055/メガピクセルの従量制。本実装は portrait_4_3 (約1メガピクセル相当)で
 * 1枚生成するため、1枚あたりの概算値として登録する(要検証)。
 */
export const FLUX_PRO_COST_PER_IMAGE_USD = Number(process.env.FLUX_PRO_COST_PER_IMAGE_USD ?? '0.055') || 0.055;

/**
 * LemonSlice アバター登録(トーク中の分課金とは別の、1回限りのプロビジョニング呼び出し)の
 * 原価見積もり(USD)。公開単価情報が無く暫定値(要検証)。デフォルトは無料/未確定として0円。
 * 実費が判明次第 env override で設定する。
 */
export const LEMONSLICE_AVATAR_REGISTRATION_COST_USD =
  Number(process.env.LEMONSLICE_AVATAR_REGISTRATION_COST_USD ?? '0') || 0;

/**
 * A2A-0i: LiveKit room-token発行イベントの計上に使う model のセンチネル値。
 * livekitTokenRoutes.ts（書き込み）と billingHealthCheck.ts の固定費クォータ監視
 * （読み取り）の唯一の出どころ。usage_logs.model は本来LLMモデル名の列だが、
 * このイベントはLLM呼び出しを伴わない（inputTokens/outputTokens=0固定・billable=false）ため
 * 新しい列を増やさずに既存列を識別子として流用する。normalizeModelKey は未知の
 * モデル名を0コストとして安全に扱う（LLM_COSTSに存在しないため）。
 */
export const LIVEKIT_ROOM_TOKEN_MODEL = 'livekit-room-token';

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** マージン倍率の上書き（省略時は MARGIN_MULTIPLIER を使用） */
  marginOverride?: number;
  /** Phase40: Fish Audio TTSに送ったテキストのUTF-8バイト数 */
  ttsTextBytes?: number;
  /** GID 1217083837550852: 実際に使用したFish Audio TTSモデル名（単価の決定に使う） */
  ttsModel?: string;
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
  /** GID 1216944049264977: Qwen OCRで処理したページ数 */
  ocrPages?: number;
  /** GID 1216944049264977: Fish Audio ASR呼び出し回数（通常1リクエスト=1)。asrAudioSeconds未指定時のフォールバックのみに使う */
  asrRequestCount?: number;
  /** GID 1217083837550916: Fish Audio ASRの実測音声長(秒)。指定時はこちらを優先し asrRequestCount とは二重計上しない */
  asrAudioSeconds?: number;
  /** GID 1217084040137242: Fish Audio Voice Design 呼び出し回数（成功リクエストのみ計上） */
  voiceDesignRequestCount?: number;
  /** GID 1216944049264977: Magnificアップスケール実行回数 */
  magnificUpscaleCount?: number;
  /** GID 1216944049264977: Flux 2 Pro 画像生成枚数 */
  fluxImageCount?: number;
  /** GID 1216944049264977: LemonSliceアバター登録（プロビジョニング）回数 */
  lemonsliceRegistrationCount?: number;
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

// GID: totalUSDの計算式に加算されるフィールド群（マイナス値は「請求額を減らす」
// 攻撃・不具合の経路になりうる）。現状の全呼び出し元(fishTtsRoutes/fishAsrRoutes/
// generationRoutes/usageRoutes)は非負値しか渡さないため実害は無いが、将来別の
// 呼び出し元が検証漏れの値をそのまま渡した場合に静かに請求額が減るのを防ぐため、
// calculateBillingAmountCentsの入口で一括ガードする。
const NEGATIVE_GUARD_FIELDS: ReadonlyArray<keyof UsageRecord> = [
  'ttsTextBytes', 'avatarCredits', 'imageCount', 'saiAgentSteps', 'ocrPages',
  'asrRequestCount', 'asrAudioSeconds', 'magnificUpscaleCount', 'fluxImageCount',
  'lemonsliceRegistrationCount', 'voiceDesignRequestCount',
];

/**
 * 1リクエストの実原価を USD で返す（マージン適用前）。
 *
 * calculateBillingAmountCents（マージン後）と calculateBaseCostCents（マージン前）の
 * 唯一の計算元。★原価の式をこの関数の外にもう1本書かないこと★ —
 * 2本になると、新しい原価項目（外部APIの追加など）を片方にだけ足したときに
 * 「請求はされているのに粗利には出ない」原価が静かに生まれる。
 *
 * @throws inputTokens / outputTokens / NEGATIVE_GUARD_FIELDS が負の場合
 */
function _computeTotalCostUsd(usage: UsageRecord): number {
  if (usage.inputTokens < 0 || usage.outputTokens < 0) {
    throw new Error(
      `Invalid token counts: input=${usage.inputTokens}, output=${usage.outputTokens}`
    );
  }
  for (const field of NEGATIVE_GUARD_FIELDS) {
    const value = usage[field];
    if (typeof value === 'number' && value < 0) {
      throw new Error(`Invalid ${field}: ${value}`);
    }
  }

  // 本行の LLM コスト + 同一リクエスト内の追加 LLM 呼び出し（planner 等）をモデル別実レートで合算。
  const llmUSD   = _calculateLLMCostUSD(usage) + _sumExtraLlmUsd(usage.extraLlmUsages);
  const ttsUSD   = (usage.ttsTextBytes  ?? 0) * fishTtsCostPerByteUsd(usage.ttsModel);
  const avtrUSD  = (usage.avatarCredits ?? 0) * LEMONSLICE_COST_PER_CREDIT_USD;
  const imgUSD   = (usage.imageCount    ?? 0) * IMAGE_GENERATION_COST_USD;
  const anamUSD  = (usage.anam_session_seconds ?? 0) > 0
    ? calculateAnamSessionCostCents(usage.anam_session_seconds!) / 100
    : 0;
  const saiUSD   = (usage.saiAgentSteps ?? 0) * SAI_AGENT_COST_PER_STEP_USD;
  // GID 1216944049264977: これまでtrackUsage対象外だった外部API課金経路。
  const ocrUSD      = (usage.ocrPages ?? 0) * QWEN_OCR_COST_PER_PAGE_USD;
  // GID 1217083837550916: 音声長(秒)が分かればそちらを優先(公式単価$0.36/hour、秒切り上げ)。
  // 分からない場合のみ従来のリクエスト単位の概算値にフォールバックする。両方を足さない。
  const asrUSD       = usage.asrAudioSeconds !== undefined
    ? (Math.ceil(usage.asrAudioSeconds) / 3600) * FISH_ASR_COST_PER_HOUR_USD
    : (usage.asrRequestCount ?? 0) * FISH_ASR_COST_PER_REQUEST_USD;
  const magnificUSD  = (usage.magnificUpscaleCount ?? 0) * MAGNIFIC_UPSCALE_COST_USD;
  const fluxUSD      = (usage.fluxImageCount ?? 0) * FLUX_PRO_COST_PER_IMAGE_USD;
  const lemonRegUSD  = (usage.lemonsliceRegistrationCount ?? 0) * LEMONSLICE_AVATAR_REGISTRATION_COST_USD;
  const voiceDesignUSD = (usage.voiceDesignRequestCount ?? 0) * VOICE_DESIGN_COST_PER_REQUEST_USD;
  return llmUSD + SERVER_COST_PER_REQUEST_USD + ttsUSD + avtrUSD + imgUSD + anamUSD + saiUSD
    + ocrUSD + asrUSD + magnificUSD + fluxUSD + lemonRegUSD + voiceDesignUSD;
}

/**
 * 1リクエストの課金金額をセント単位（整数）で返す。
 *
 * - エンドユーザー向け機能（chat/avatar/voice）: MARGIN_MULTIPLIER 適用
 * - 管理者・運用向け機能: × 1（原価のみ）
 * - featureUsed 未指定時は後方互換のため MARGIN_MULTIPLIER を適用
 *
 * 中間丸めを避けるため USD のまま合算してから最後に変換する
 * （合算は _computeTotalCostUsd が行う）。
 *
 * @throws inputTokens / outputTokens が負の場合
 */
export function calculateBillingAmountCents(usage: UsageRecord): number {
  const isEndUser = usage.featureUsed === undefined || END_USER_FEATURES.has(usage.featureUsed);
  const margin    = usage.marginOverride ?? (isEndUser ? MARGIN_MULTIPLIER : 1);
  return Math.ceil(_computeTotalCostUsd(usage) * margin * 100);
}

/**
 * 1リクエストの実原価をセント単位（整数）で返す。マージンを一切適用しない。
 *
 * usage_logs.cost_base_cents に記録され、テナント別粗利（売上 − API原価）の
 * 原価側になる。cost_total_cents（マージン後）との違いは margin だけ。
 *
 * ★cost_base_cents * margin === cost_total_cents にはならない★
 * Math.ceil が両方に別々に効くため、最大で margin セントぶんずれる。
 * cost_total_cents は既存の請求突合に使われている値なので、こちらに合わせて
 * 丸め方を変えたりはしない（請求側の数値を動かさないことを優先する）。
 */
export function calculateBaseCostCents(usage: UsageRecord): number {
  return Math.ceil(_computeTotalCostUsd(usage) * 100);
}
