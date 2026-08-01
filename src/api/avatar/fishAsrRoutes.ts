// POST /api/voice/asr
//   body: multipart/form-data, field "audio" (audio blob, max 20MB — Fish Audio公式ASR上限に合わせる)
//   認証: apiStack
//   Fish Audio Transcribe-1 ASR → { text: string }

import crypto from 'node:crypto';
import multer from 'multer';
import type { Express, NextFunction, Request, Response, RequestHandler } from 'express';
import type { AuthedRequest } from '../../agent/http/authMiddleware';
import { logger } from '../../lib/logger';
import { trackUsage } from '../../lib/billing/usageTracker';
import { parseWavDurationSeconds } from '../../lib/audio/wavDuration';

const FISH_ASR_API = 'https://api.fish.audio/v1/asr';

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^audio\//i.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('UNSUPPORTED_AUDIO_TYPE'));
    }
  },
});

// GID 1217083837550916 / 実機発見: multer のアップロード失敗(サイズ超過・非audio MIME・
// 同一フィールドへの複数ファイル添付など)はどれもデフォルトのExpressエラー処理に落ちると、
// HTMLの500エラー(内部スタックトレース・サーバーのファイルパスを含む)が返っていた
// （本番でも同様）。この位置に到達するエラーは multer(single('audio')の処理)由来のみ
// のため、種別を問わずクライアント起因のアップロード失敗として安全な日本語400へ変換する。
// Express は err.length===3 の通常ミドルウェアと err.length===4 のエラーハンドラを
// 同一ルートのスタック内でも区別するため、single()の直後に置けば失敗時のみ呼ばれる。
function handleAsrUploadError(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({
      error: '録音が長すぎます。20MB未満になるよう、もう一度短く録音してお試しください。',
    });
    return;
  }
  if (err instanceof Error && err.message === 'UNSUPPORTED_AUDIO_TYPE') {
    res.status(400).json({
      error: '音声ファイルの形式に対応していません。もう一度録音するか、別の音声ファイルでお試しください。',
    });
    return;
  }
  logger.warn({ err }, '[fishAsr] upload rejected by multer (unclassified)');
  res.status(400).json({
    error: '録音を受け取れませんでした。もう一度録音してお試しください。',
  });
}

export function registerFishAsrRoutes(app: Express, apiStack: RequestHandler[]): void {
  logger.info('[fishAsr] POST /api/voice/asr registered');

  app.post(
    '/api/voice/asr',
    ...apiStack,
    audioUpload.single('audio'),
    handleAsrUploadError,
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

      // GID 1217083837550916: widgetは_blobToWav()でWAV化してから送るため、
      // ここで実測秒数を算出できれば公式単価($0.36/audio hour)で正確に計上できる。
      // WAV以外/解析不能な場合のみ従来のリクエスト単位の概算値にフォールバックする。
      const durationSeconds = parseWavDurationSeconds(req.file.buffer);

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

        // GID 1216944049264977: Fish ASRは外部API課金経路だがこれまでtrackUsage対象外だった。
        // voice入力の一部（ユーザー向け機能）なのでfeatureUsed='voice'扱い（MARGIN_MULTIPLIER適用）。
        trackUsage({
          tenantId,
          requestId: crypto.randomUUID(),
          model: 'fish-audio-asr',
          inputTokens: 0,
          outputTokens: 0,
          featureUsed: 'voice',
          ...(durationSeconds !== null
            ? { asrAudioSeconds: durationSeconds }
            : { asrRequestCount: 1 }),
        });

        return res.json({ text });

      } catch (err) {
        logger.error({ err, tenantId }, '[fishAsr] ASR request failed');
        return res.status(500).json({ error: 'ASR failed' });
      }
    },
  );
}
