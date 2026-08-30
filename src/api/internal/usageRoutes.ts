// src/api/internal/usageRoutes.ts
//
// POST /api/internal/usage
//   認証: X-Internal-Request: 1（Prometheusメトリクスと同じ方式）
//   avatar-agent/agent.py からTTS/Avatar使用量を受信してDBに記録する。
//
// Body: { tenantId, requestId?, ttsTextBytes?, ttsModel?, avatarCredits?, avatarSessionMs? }

import { GPT_OSS_120B } from '../../config/groqModels';
import type { Express, Request, Response } from 'express';
import { INTERNAL_REQUEST_HEADER } from '../../lib/metrics/kpiDefinitions';
import { trackUsage, type FeatureUsed } from '../../lib/billing/usageTracker';
import { FISH_AUDIO_KNOWN_TTS_MODELS } from '../../lib/billing/costCalculator';
import { internalNetworkOnly } from '../middleware/internalNetworkOnly';
import { internalHmacMiddleware } from '../../lib/crypto/hmacVerifier';

const ALLOWED_FEATURES: readonly FeatureUsed[] = ['avatar', 'voice'];

export function registerInternalUsageRoutes(app: Express): void {
  // 多層防御: internalNetworkOnly(loopback限定) の内側に HMAC 署名検証を追加。
  // 固定ヘッダ X-Internal-Request だけでは body.tenantId を全信用でき、
  // loopback に到達できる同居プロセス/SSRF から偽課金が可能だった (P0)。
  // secret 未設定時は internalHmacMiddleware が fail-closed(500) する (ga4 と同一方式)。
  app.post('/api/internal/usage', internalNetworkOnly, internalHmacMiddleware, (req: Request, res: Response) => {
    if (req.headers[INTERNAL_REQUEST_HEADER] !== '1') {
      return res.status(403).json({ error: 'forbidden' });
    }

    const body = req.body ?? {};
    const { tenantId, requestId, ttsTextBytes, ttsModel, avatarCredits, avatarSessionMs, inputTokens, outputTokens, model, featureUsed } = body;

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId required' });
    }

    // requestId 未指定時は自動生成（agent.py が requestId を管理しない場合）
    const rid: string =
      requestId && typeof requestId === 'string'
        ? requestId
        : `avatar-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const resolvedFeature: FeatureUsed =
      typeof featureUsed === 'string' && (ALLOWED_FEATURES as readonly string[]).includes(featureUsed)
        ? (featureUsed as FeatureUsed)
        : 'avatar';

    // sessionId は渡さない（usage_logs.session_id は NULL のまま）。
    // 呼び出し元の avatar-agent/agent.py は LiveKit の room 名しか知らず、
    // R2C の chat_sessions.session_id をそもそも受け取っていない。
    // アバターは「分」で請求する（stripeSync の avatar_session_ms 加重）ため
    // 会話のグルーピングを必要とせず、ここでは不要。
    // ※ その代わり「同じ会話をテキストとアバターの両方で二重計上しない」判定は
    //   この経路の行に対しては行えない。詳細は stripeSync.computeExpectedBilling の
    //   コメント（既知の制約）を参照。
    trackUsage({
      tenantId,
      requestId: rid,
      model: typeof model === 'string' && model ? model : GPT_OSS_120B,
      inputTokens: typeof inputTokens === 'number' && inputTokens >= 0 ? inputTokens : 0,
      outputTokens: typeof outputTokens === 'number' && outputTokens >= 0 ? outputTokens : 0,
      featureUsed: resolvedFeature,
      ttsTextBytes:
        typeof ttsTextBytes === 'number' && ttsTextBytes >= 0 ? ttsTextBytes : undefined,
      ttsModel:
        typeof ttsModel === 'string' && FISH_AUDIO_KNOWN_TTS_MODELS.includes(ttsModel)
          ? ttsModel
          : undefined,
      avatarCredits:
        typeof avatarCredits === 'number' && avatarCredits >= 0 ? avatarCredits : undefined,
      avatarSessionMs:
        typeof avatarSessionMs === 'number' && avatarSessionMs >= 0 ? avatarSessionMs : undefined,
    });

    return res.json({ ok: true });
  });
}
