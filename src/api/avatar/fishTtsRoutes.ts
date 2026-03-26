// Phase42: Fish Audio TTS エンドポイント
// POST /api/avatar/tts
//   body: { text: string }
//   認証: apiStack
//   Fish Audio API → MP3バイナリを返す

import type { Express, Request, Response, RequestHandler } from 'express';
import type { AuthedRequest } from '../../agent/http/authMiddleware';

const FISH_AUDIO_API = 'https://api.fish.audio/v1/tts';

export function registerFishTtsRoutes(app: Express, apiStack: RequestHandler[]): void {
  console.log('[fishTts] POST /api/avatar/tts registered');

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
    const referenceId = process.env.FISH_AUDIO_REFERENCE_ID?.trim();
    if (!fishApiKey) {
      return res.status(500).json({ error: 'TTS not configured' });
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
          reference_id: referenceId || '63bc41e652214372b15d9416a30a60b4',
          format: 'mp3',
          latency: 'balanced',
        }),
      });

      if (!fishRes.ok) {
        const errText = await fishRes.text();
        console.error(`[fishTts] Fish Audio error ${fishRes.status}: ${errText.slice(0, 200)}`);
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

    } catch (err) {
      console.error('[fishTts] Error:', err);
      res.status(500).json({ error: 'TTS failed' });
    }
  });
}
