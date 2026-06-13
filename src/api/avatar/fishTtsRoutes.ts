// Phase42: Fish Audio TTS エンドポイント

// POST /api/avatar/tts
//   body: { text: string }
//   認証: apiStack
//   Fish Audio API → MP3バイナリを返す

import type { Express, Request, Response, RequestHandler } from 'express';
import type { AuthedRequest } from '../../agent/http/authMiddleware';
import { getPool } from '../../lib/db';
import { logger } from '../../lib/logger';
import { trackUsage } from '../../lib/billing/usageTracker';

const FISH_AUDIO_API = 'https://api.fish.audio/v1/tts';

export function registerFishTtsRoutes(app: Express, apiStack: RequestHandler[]): void {
  logger.info('[fishTts] POST /api/avatar/tts registered');

  app.post('/api/avatar/tts', ...apiStack, async (req: Request, res: Response) => {
    const tenantId = (req as AuthedRequest).tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text required' });
    }

    const fishApiKey = process.env.FISH_AUDIO_API_KEY?.trim();
    if (!fishApiKey) {
      return res.status(500).json({ error: 'TTS not configured' });
    }

    // テナントのアクティブアバター voice_id を解決（avatarConfigRoutes と同一クエリ）
    // body から voiceId は受けない（テナント越境防止）
    let referenceId = process.env.FISH_AUDIO_REFERENCE_ID?.trim() || undefined;
    try {
      const result = await getPool().query<{ voice_id: string | null }>(
        `SELECT voice_id FROM avatar_configs WHERE tenant_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      );
      if (result.rows[0]?.voice_id) referenceId = result.rows[0].voice_id;
    } catch (err) {
      logger.warn({ err, tenantId }, '[fishTts] voice_id resolve failed — env fallback');
    }

    try {
      const fishRes = await fetch(FISH_AUDIO_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${fishApiKey}`,
        },
        body: JSON.stringify({
          text: text,
          model: 's2-pro',
          ...(referenceId ? { reference_id: referenceId } : {}),
          format: 'mp3',
          latency: 'balanced',
        }),
      });

      if (!fishRes.ok) {
        const errText = await fishRes.text();
        logger.error(`[fishTts] Fish Audio error ${fishRes.status}: ${errText.slice(0, 200)}`);
        return res.status(502).json({ error: 'TTS error' });
      }

      // MP3バイナリをそのままクライアントに転送
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-cache');

      const reader = fishRes.body?.getReader();
      if (!reader) {
        return res.status(502).json({ error: 'No TTS stream' });
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();

      trackUsage({
        tenantId,
        requestId: (req as any).requestId ?? `tts-${Date.now()}`,
        model: 'fish-audio-s2-pro',
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: 'voice',
        ttsTextBytes: Buffer.byteLength(text, 'utf8'),
      });

    } catch (err) {
      logger.error('[fishTts] Error:', err);
      res.status(500).json({ error: 'TTS failed' });
    }
  });
}
