import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { hybridSearch } from './search/hybrid';

const logger = pino({ transport: { target: 'pino-pretty' } });
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/search', async (req, res) => {
  const bodySchema = z.object({ q: z.string().min(1) });
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'invalid body' });

  const t0 = Date.now();
  try {
    const result = await hybridSearch(parse.data.q);
    res.json({ took_ms: Date.now() - t0, ...result });
  } catch (e: any) {
    logger.error(e);
    // 失敗時も API を死なせない（モック返却）
    res.json({
      took_ms: Date.now() - t0,
      items: [
        { id: 'mock-1', text: '（モック）返品ポリシー', score: 0.9, source: 'es' },
        { id: 'mock-2', text: '（モック）送料の考え方', score: 0.8, source: 'pg' }
      ],
      ms: 0,
      note: 'ES/PG未接続のためモック応答'
    });
  }
});

const port = Number(process.env.PORT || 3000);
// 追加: 起動時に接続先スナップショットを出す
logger.info({ ES_URL: process.env.ES_URL, DATABASE_URL: process.env.DATABASE_URL }, 'env snapshot');
app.listen(port, () => {
  logger.info(`server listening on :${port}`);
});