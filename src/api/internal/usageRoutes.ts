// src/api/internal/usageRoutes.ts
//
// POST /api/internal/usage
//   認証: X-Internal-Request: 1（Prometheusメトリクスと同じ方式）
//   avatar-agent/agent.py からTTS/Avatar使用量を受信してDBに記録する。
//
// Body: { tenantId, requestId?, ttsTextBytes?, avatarCredits?, avatarSessionMs? }

import type { Express, Request, Response } from 'express';
import { INTERNAL_REQUEST_HEADER } from '../../lib/metrics/kpiDefinitions';
import { trackUsage } from '../../lib/billing/usageTracker';

export function registerInternalUsageRoutes(app: Express): void {
  app.post('/api/internal/usage', (req: Request, res: Response) => {
    if (req.headers[INTERNAL_REQUEST_HEADER] !== '1') {
      return res.status(403).json({ error: 'forbidden' });
    }

    const body = req.body ?? {};
    const { tenantId, requestId, ttsTextBytes, avatarCredits, avatarSessionMs } = body;

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId required' });
    }

    // requestId 未指定時は自動生成（agent.py が requestId を管理しない場合）
    const rid: string =
      requestId && typeof requestId === 'string'
        ? requestId
        : `avatar-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    trackUsage({
      tenantId,
      requestId: rid,
      model: 'llama-3.3-70b-versatile',  // avatarセッションのLLM
      inputTokens: 0,
      outputTokens: 0,
      featureUsed: 'avatar',
      ttsTextBytes:
        typeof ttsTextBytes === 'number' && ttsTextBytes >= 0 ? ttsTextBytes : undefined,
      avatarCredits:
        typeof avatarCredits === 'number' && avatarCredits >= 0 ? avatarCredits : undefined,
      avatarSessionMs:
        typeof avatarSessionMs === 'number' && avatarSessionMs >= 0 ? avatarSessionMs : undefined,
    });

    return res.json({ ok: true });
  });
}
