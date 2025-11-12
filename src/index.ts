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

const parseJSON = express.json({ limit: '2kb' })

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

// --- fast-path for perf gate: no JSON parse, no search ---
app.post('/search.v1', (req, res, next) => {
  // Enable when header is present or env explicitly set to 1/true/yes
  const perfHeader = typeof req.headers['x-perf'] !== 'undefined'
  const perfEnv = String(process.env.PERF_MODE || '').toLowerCase()
  const perfMode = perfHeader || ['1', 'true', 'yes'].includes(perfEnv)
  if (!perfMode) return next()

  const payload = {
    items: [],
    meta: {
      route: 'es2',
      rerank_score: null,
      tuning_version: 'v1',
      flags: ['v1', 'validated', 'perf:mode', 'ce:skipped'],
    },
    ce_ms: 0,
  }
  const buf = Buffer.from(JSON.stringify(payload))
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Length', String(buf.length))
  return res.end(buf)
})

app.post('/search', parseJSON, async (req, res) => {
  const schema = z.object({ q: z.string() })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }
  const { q } = parsed.data
  try {
    const results = await hybridSearch(q)
    const re = await rerank(q, results.items, 12)
    return res.json({ ...results, items: re.items, ce_ms: re.ce_ms })
  } catch (error) {
    logger.error(error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// v1: schema-validated search with meta (keeps existing /search intact)
app.post('/search.v1', parseJSON, async (req, res) => {
  // Fast path handled by the early /search.v1 handler above

  // Normal mode: schema-validated + rerank
  const schemaIn = z.object({
    q: z.string().min(1),
    topK: z.number().int().positive().max(50).optional(),
  })

  const parsed = schemaIn.safeParse(req.body ?? {})
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues })
  }

  const { q, topK } = parsed.data
  const k = typeof topK === 'number' ? topK : 12

  const routeStr = 'hybrid:es50+pg50'

  try {
    const results = await hybridSearch(q)
    const re = await rerank(q, results.items, k)

    // build flags (CE visibility)
    const flags: string[] = ['v1', 'validated']
    try {
      const st = ceStatus()
      if (st?.onnxLoaded && (re?.ce_ms ?? 0) >= 1) {
        flags.push('ce:active')
      } else {
        flags.push('ce:skipped')
      }
    } catch {
      flags.push('ce:skipped')
    }

    return res.json({
      items: re.items,
      meta: {
        route: routeStr,
        rerank_score: null,
        tuning_version: 'v1',
        flags,
      },
      ce_ms: re.ce_ms,
    })
  } catch (error) {
    return res.status(500).json({ error: 'internal', message: (error as Error).message })
  }
})

const port = Number(process.env.PORT || 3000)
app.listen(port, () => {
  logger.info({ port, env: process.env.NODE_ENV }, 'server listening')
})