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
import { queryTenantPlan, planHasFeature } from '../../lib/billing/planFeatures';

const FISH_AUDIO_API = 'https://api.fish.audio/v1/tts';

// GID(voice plan gate): TTS 入力テキストのバイト長上限。Fish Audio TTS は $15/1M byte の
// 従量課金で、1リクエストのバイト数がそのまま原価になる。上限が無いと、認可済みプランの
// テナントでも1回の巨大textで原価が跳ね、公開api-key経由の増幅も可能。既定 2000 byte
// (日本語で概ね600〜660字相当)。env TTS_MAX_INPUT_BYTES で調整可能。
const DEFAULT_TTS_MAX_INPUT_BYTES = 2000;

function ttsMaxInputBytes(): number {
  const raw = process.env.TTS_MAX_INPUT_BYTES?.trim();
  if (!raw) return DEFAULT_TTS_MAX_INPUT_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTS_MAX_INPUT_BYTES;
}

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

    // 入力テキストのバイト長上限(原価上限)。DB を引く前の純粋な入力検証として先に弾く。
    const textBytes = Buffer.byteLength(text, 'utf8');
    const maxBytes = ttsMaxInputBytes();
    if (textBytes > maxBytes) {
      return res.status(413).json({ error: 'text_too_long', maxBytes, actualBytes: textBytes });
    }

    // プランゲート: TTS は Fish Audio 従量課金($15/1M byte)を発生させるため、
    // voice 機能を含むプラン(既定 Standard 以上)に限定する。free_ad(倍率0)/starter の
    // 公開api-keyから叩かれると請求不能な原価がそのまま会社負担になり、匿名コスト増幅DoSに
    // なる。fail-safe: queryTenantPlan は取得失敗時に free_ad を返す(=ここで403、原価は発生
    // させない)。原価保護ゲートなので DB障害時も fail-closed で正しい。
    const plan = await queryTenantPlan(getPool(), tenantId);
    if (!planHasFeature(plan, 'voice')) {
      logger.warn(`[fishTts] plan=${plan} lacks voice feature — blocked tenant: ${tenantId}`);
      return res.status(403).json({ error: 'plan_upgrade_required', feature: 'voice' });
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

    const ttsModel = process.env.FISH_AUDIO_TTS_MODEL?.trim() || 's2.1-pro-free';

    try {
      const fishRes = await fetch(FISH_AUDIO_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${fishApiKey}`,
        },
        body: JSON.stringify({
          text: text,
          model: ttsModel,
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
        model: `fish-audio-${ttsModel}`,
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: 'voice',
        ttsTextBytes: Buffer.byteLength(text, 'utf8'),
        ttsModel,
      });

    } catch (err) {
      logger.error('[fishTts] Error:', err);
      res.status(500).json({ error: 'TTS failed' });
    }
  });
}
