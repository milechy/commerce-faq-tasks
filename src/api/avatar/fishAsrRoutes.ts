// POST /api/voice/asr
//   body: multipart/form-data, field "audio" (audio blob, max 25MB)
//   認証: apiStack
//   Fish Audio Transcribe-1 ASR → { text: string }

import multer from 'multer';
import type { Express, Request, Response, RequestHandler } from 'express';
import type { AuthedRequest } from '../../agent/http/authMiddleware';
import { logger } from '../../lib/logger';

const FISH_ASR_API = 'https://api.fish.audio/v1/asr';

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^audio\//i.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('audio file required'));
    }
  },
});

export function registerFishAsrRoutes(app: Express, apiStack: RequestHandler[]): void {
  logger.info('[fishAsr] POST /api/voice/asr registered');

  app.post(
    '/api/voice/asr',
    ...apiStack,
    audioUpload.single('audio'),
    async (req: Request, res: Response) => {
      const tenantId = (req as AuthedRequest).tenantId;
      if (!tenantId) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'audio file required' });
      }

      const fishApiKey = process.env.FISH_AUDIO_API_KEY?.trim();
      if (!fishApiKey) {
        return res.status(503).json({ error: 'ASR not configured' });
      }

      try {
        const fd = new FormData();
        fd.append(
          'audio',
          new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }),
          req.file.originalname || 'audio.webm',
        );
        fd.append('language', 'ja');
        fd.append('ignore_timestamps', 'true');

        const fishRes = await fetch(FISH_ASR_API, {
          method: 'POST',
          headers: { Authorization: `Bearer ${fishApiKey}` },
          body: fd,
        });

        if (!fishRes.ok) {
          const detail = await fishRes.text().catch(() => '');
          logger.warn(
            { status: fishRes.status, detail: detail.slice(0, 200), tenantId },
            '[fishAsr] Fish Audio ASR error',
          );
          return res.status(502).json({ error: 'ASR error' });
        }

        const data = (await fishRes.json()) as { text?: string };
        const text = (data.text ?? '').trim();
        return res.json({ text });

      } catch (err) {
        logger.error({ err, tenantId }, '[fishAsr] ASR request failed');
        return res.status(500).json({ error: 'ASR failed' });
      }
    },
  );
}
