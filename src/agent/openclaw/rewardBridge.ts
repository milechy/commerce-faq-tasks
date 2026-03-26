// src/agent/openclaw/rewardBridge.ts
// Phase47: Judge評価 → OpenClaw-RL reward signal 変換・送信アダプタ
//
// Judge score (0–100) を 0.0–1.0 に正規化し、
// OpenClaw-RL Python API サーバーへ POST /reward で非同期送信する。
// Feature Flag オフ時は何もしない（後方互換）。

import pino from "pino";
import { isOpenClawEnabled } from "./featureFlag";

const logger = pino();

const OPENCLAW_RL_URL = process.env.OPENCLAW_RL_URL ?? "http://localhost:3200";

export interface RewardPayload {
  tenantId: string;
  sessionId: string;
  variantId: string | null;
  score: number; // 0–100 (Judge score)
  outcome: string; // 'replied' | 'appointment' | 'lost' | 'unknown'
}

/**
 * Judge評価スコアを OpenClaw-RL reward signal として送信する。
 * 失敗しても呼び出し元には伝播させない（fire-and-forget）。
 */
export async function sendRewardSignal(payload: RewardPayload): Promise<void> {
  if (!isOpenClawEnabled(payload.tenantId)) return;

  const normalizedScore = Math.max(0, Math.min(1, payload.score / 100));

  // outcome bonus: appointment +0.1, lost -0.1
  const outcomeBonus =
    payload.outcome === "appointment" ? 0.1 :
    payload.outcome === "lost" ? -0.1 : 0;

  const reward = Math.max(0, Math.min(1, normalizedScore + outcomeBonus));

  try {
    const res = await fetch(`${OPENCLAW_RL_URL}/reward`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: payload.tenantId,
        session_id: payload.sessionId,
        variant_id: payload.variantId,
        reward,
        raw_score: payload.score,
        outcome: payload.outcome,
      }),
      signal: AbortSignal.timeout(3000), // 3秒タイムアウト
    });

    if (!res.ok) {
      logger.warn({ status: res.status, tenantId: payload.tenantId }, "[OpenClaw-RL] reward送信失敗");
    } else {
      logger.debug({ reward, tenantId: payload.tenantId }, "[OpenClaw-RL] reward送信成功");
    }
  } catch (err) {
    // タイムアウト・接続拒否はサイレントに無視（本番フローに影響させない）
    logger.warn({ err, tenantId: payload.tenantId }, "[OpenClaw-RL] reward送信エラー（無視）");
  }
}
