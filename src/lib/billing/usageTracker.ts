// src/lib/billing/usageTracker.ts
// Phase32: API使用量の非同期記録（fire-and-forget）

import { Pool } from 'pg';
import type pino from 'pino';
import { calculateLLMCostCents, calculateBillingAmountCents } from './costCalculator';

export type FeatureUsed = 'chat' | 'avatar' | 'voice' | 'avatar_config_image' | 'avatar_config_voice' | 'avatar_config_prompt' | 'avatar_config_test' | 'anam_session';

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
  /** Phase40: Lemonsliceのクレジット消費量 */
  avatarCredits?: number;
  /** Phase40: LiveKitセッション時間（ミリ秒） */
  avatarSessionMs?: number;
  /** Phase42: Anamセッション時間（秒） */
  anam_session_seconds?: number;
  /** Phase53: 生成画像枚数 */
  imageCount?: number;
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
    featureUsed, marginOverride, ttsTextBytes, avatarCredits, avatarSessionMs, imageCount,
  } = params;

  let costLlmCents = 0;
  let costTotalCents = 0;
  try {
    costLlmCents   = calculateLLMCostCents({ model, inputTokens, outputTokens });
    costTotalCents = calculateBillingAmountCents({
      model, inputTokens, outputTokens, marginOverride,
      ttsTextBytes, avatarCredits, avatarSessionMs,
      featureUsed, imageCount,
    });
  } catch (err) {
    _logger?.warn({ err, requestId }, '[usageTracker] cost calculation error, defaulting to 0');
  }

  try {
    await _pool.query(
      `INSERT INTO usage_logs
         (tenant_id, request_id, model, input_tokens, output_tokens,
          feature_used, cost_llm_cents, cost_total_cents,
          tts_text_bytes, avatar_credits, avatar_session_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (request_id) DO NOTHING`,
      [tenantId, requestId, model, inputTokens, outputTokens,
       featureUsed, costLlmCents, costTotalCents,
       ttsTextBytes ?? null, avatarCredits ?? null, avatarSessionMs ?? null]
    );
    _logger?.debug(
      { tenantId, requestId, costLlmCents, costTotalCents },
      '[usageTracker] logged'
    );
  } catch (err) {
    // DB エラーはログするが API レスポンスには影響させない
    _logger?.error({ err, requestId, tenantId }, '[usageTracker] db insert failed');
  }
}
