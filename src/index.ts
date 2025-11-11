import 'dotenv/config'
import express from 'express'
import pino from 'pino'
import { z } from 'zod'
import { hybridSearch } from './search/hybrid'
import { warmupCE, ceStatus } from './search/rerank'

const app = express()
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))
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
    res.json(results)
  } catch (error) {
    logger.error(error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const port = Number(process.env.PORT || 3000)
app.listen(port, () => {
  logger.info({ port, env: process.env.NODE_ENV }, 'server listening')
})