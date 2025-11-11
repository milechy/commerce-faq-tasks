import 'dotenv/config'
import express from 'express'
import pino from 'pino'
import { z } from 'zod'
import { hybridSearch } from './search/hybrid'
import { warmupCE, ceStatus, rerank } from './search/rerank'

const app = express()
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

// env snapshot for troubleshooting
logger.info({
  ES_URL: process.env.ES_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  HYBRID_TIMEOUT_MS: process.env.HYBRID_TIMEOUT_MS,
}, 'env snapshot')

app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/debug/env', (_req, res) => {
  res.json({
    ES_URL: process.env.ES_URL || null,
    DATABASE_URL: process.env.DATABASE_URL || null,
    hasES: Boolean(process.env.ES_URL),
    hasPG: Boolean(process.env.DATABASE_URL),
  })
})
app.get('/ce/status', (_req, res) => res.json(ceStatus()))
app.post('/ce/warmup', async (_req, res) => {
  const r = await warmupCE()
  res.json(r)
})

app.post('/search', async (req, res) => {
  const schema = z.object({ q: z.string() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }
  const { q } = parsed.data
  try {
    const results = await hybridSearch(q)
    const re = await rerank(q, results.items, 12);
    return res.json({ ...results, items: re.items, ce_ms: re.ce_ms });
    // res.json(results)
  } catch (error) {
    logger.error(error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const port = Number(process.env.PORT || 3000)
app.listen(port, () => {
  logger.info({ port, env: process.env.NODE_ENV }, 'server listening')
})