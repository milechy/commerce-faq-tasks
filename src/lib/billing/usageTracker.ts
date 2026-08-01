// src/lib/billing/usageTracker.ts
// Phase32: API使用量の非同期記録（fire-and-forget）

import type pino from 'pino';
import { calculateLLMCostCents, calculateBillingAmountCents, normalizeModelKey, NON_BILLABLE_FEATURES } from './costCalculator';

// DBのusage_logs_feature_used_check制約(migration_sai_agent_feature.sql /
// migration_admin_tooling_feature.sql)と一致させる。
// admin_guide / feedback_ai / book_analysis / book_structurize はDB側の制約には既に
// 含まれていたがTS型に無く未使用だった値（GID 1216944049264977 で配線）。
// admin_tuning / admin_ai_assist / admin_engagement_suggest / admin_option_estimator は
// GID 1216944003337186 で新設（いずれもNON_BILLABLE_FEATURES、原価可視化のみが目的）。
export type FeatureUsed = 'chat' | 'avatar' | 'voice' | 'admin_guide' | 'avatar_config_image' | 'avatar_config_voice' | 'avatar_config_prompt' | 'avatar_config_test' | 'anam_session' | 'feedback_ai' | 'book_analysis' | 'book_structurize' | 'option_service' | 'premium_avatar_generation' | 'admin_agent' | 'sai_agent' | 'admin_tuning' | 'admin_ai_assist' | 'admin_engagement_suggest' | 'admin_option_estimator';

export interface TrackUsageParams {
  tenantId: string;
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  featureUsed: FeatureUsed;
  /** マージン倍率の上書き（省略時は MARGIN_MULTIPLIER を使用） */
  marginOverride?: number;
  /** Phase40: Fish Audio TTSに送ったテキストのUTF-8バイト数 */
  ttsTextBytes?: number;
  /** GID 1217083837550852: 実際に使用したFish Audio TTSモデル名（原価計算にのみ使う。DB列は追加しない） */
  ttsModel?: string;
  /** Phase40: Lemonsliceのクレジット消費量 */
  avatarCredits?: number;
  /** Phase40: LiveKitセッション時間（ミリ秒） */
  avatarSessionMs?: number;
  /** Phase42: Anamセッション時間（秒） */
  anam_session_seconds?: number;
  /** Phase53: 生成画像枚数 */
  imageCount?: number;
  /**
   * Subtask 3: 同一リクエスト内の追加 LLM 呼び出し（マルチステップ planner 等）を
   * モデル別の実レートで本行のコストに内包する（別 usage_log を作らず請求リクエスト数を保つ）。
   */
  extraLlmUsages?: Array<{ model: string; inputTokens: number; outputTokens: number }>;
  /** Phase3 (Sai接続ブリッジ): Agent Sが実行したステップ数（社内原価集計のみ） */
  saiAgentSteps?: number;
  /** GID 1216944049264977: Qwen OCRで処理したページ数 */
  ocrPages?: number;
  /** GID 1216944049264977: Fish Audio ASR呼び出し回数（通常1リクエスト=1) */
  asrRequestCount?: number;
  /** GID 1216944049264977: Magnificアップスケール実行回数 */
  magnificUpscaleCount?: number;
  /** GID 1216944049264977: Flux 2 Pro 画像生成枚数 */
  fluxImageCount?: number;
  /** GID 1216944049264977: LemonSliceアバター登録（プロビジョニング）回数 */
  lemonsliceRegistrationCount?: number;
  /**
   * GID 1216944003337186: この行をStripe請求数量（billedQuantity）の対象にするか。
   * 省略時は featureUsed が NON_BILLABLE_FEATURES に含まれるかどうかで自動判定する
   * （明示的に渡した場合はそちらが優先される）。cost_total_cents は billable に関わらず
   * 常に計算・記録される（原価の可視化自体は billable=false でも行う）。
   */
  billable?: boolean;
}

let _pool: any | null = null;
let _logger: pino.Logger | null = null;

export function initUsageTracker(pool: any, logger: pino.Logger): void {
  _pool = pool;
  _logger = logger;
}

/**
 * 使用量をDBに非同期で記録する（fire-and-forget）。
 * setImmediate で遅延実行するため API レスポンス速度に影響しない。
 */
export function trackUsage(params: TrackUsageParams): void {
  setImmediate(() => {
    void _insertUsageLog(params);
  });
}

async function _insertUsageLog(params: TrackUsageParams): Promise<void> {
  if (!_pool) {
    _logger?.warn({ requestId: params.requestId }, '[usageTracker] pool not initialized, skipping');
    return;
  }

  const {
    tenantId, requestId, model, inputTokens, outputTokens,
    featureUsed, marginOverride, ttsTextBytes, ttsModel, avatarCredits, avatarSessionMs, imageCount,
    anam_session_seconds, extraLlmUsages, saiAgentSteps,
    ocrPages, asrRequestCount, magnificUpscaleCount, fluxImageCount, lemonsliceRegistrationCount,
    billable,
  } = params;

  // GID 1216944003337186: billable未指定時はfeatureUsedから自動判定する。
  const isBillable = billable ?? !NON_BILLABLE_FEATURES.has(featureUsed);

  // Subtask 3: 追加 LLM（planner 等）に価格表に無いモデルが来た場合、コストは 0 計上になる。
  // env override 等で発生しうるため、サイレント未課金を避けるべく可視化ログを出す。
  if (extraLlmUsages) {
    for (const e of extraLlmUsages) {
      if ((e.inputTokens > 0 || e.outputTokens > 0) && !normalizeModelKey(e.model)) {
        _logger?.warn(
          { requestId, model: e.model },
          '[usageTracker] extra LLM model has no price entry — cost recorded as 0 (add to LLM_COSTS)',
        );
      }
    }
  }

  let costLlmCents = 0;
  let costTotalCents = 0;
  try {
    costLlmCents   = calculateLLMCostCents({ model, inputTokens, outputTokens, extraLlmUsages });
    costTotalCents = calculateBillingAmountCents({
      model, inputTokens, outputTokens, marginOverride,
      ttsTextBytes, ttsModel, avatarCredits, avatarSessionMs,
      featureUsed, imageCount, anam_session_seconds, extraLlmUsages, saiAgentSteps,
      ocrPages, asrRequestCount, magnificUpscaleCount, fluxImageCount, lemonsliceRegistrationCount,
    });
  } catch (err) {
    _logger?.warn({ err, requestId }, '[usageTracker] cost calculation error, defaulting to 0');
  }

  // Subtask 3: cost に planner 分（extraLlmUsages）を内包したので、永続化する
  // input_tokens / output_tokens にも planner トークンを合算し、コストとトークンの
  // 整合性を保つ（トークンあたりコスト分析が破綻しないようにする）。
  const totalInputTokens =
    inputTokens + (extraLlmUsages?.reduce((s, e) => s + e.inputTokens, 0) ?? 0);
  const totalOutputTokens =
    outputTokens + (extraLlmUsages?.reduce((s, e) => s + e.outputTokens, 0) ?? 0);

  try {
    await _pool.query(
      `INSERT INTO usage_logs
         (tenant_id, request_id, model, input_tokens, output_tokens,
          feature_used, cost_llm_cents, cost_total_cents,
          tts_text_bytes, avatar_credits, avatar_session_ms, anam_session_seconds, billable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (request_id) DO NOTHING`,
      [tenantId, requestId, model, totalInputTokens, totalOutputTokens,
       featureUsed, costLlmCents, costTotalCents,
       ttsTextBytes ?? null, avatarCredits ?? null, avatarSessionMs ?? null,
       anam_session_seconds ?? null, isBillable]
    );
    _logger?.debug(
      { tenantId, requestId, costLlmCents, costTotalCents, billable: isBillable },
      '[usageTracker] logged'
    );
  } catch (err) {
    // DB エラーはログするが API レスポンスには影響させない
    _logger?.error({ err, requestId, tenantId }, '[usageTracker] db insert failed');
  }
}
