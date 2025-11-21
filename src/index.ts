
import 'dotenv/config'

import express from 'express'
import pino from 'pino'
import { z } from 'zod'
import { createAgentDialogHandler } from './agent/http/agentDialogRoute'
import { createAgentSearchHandler } from './agent/http/agentSearchRoute'
import { hybridSearch } from './search/hybrid'
import { ceStatus, rerank, warmupCE } from './search/rerank'
import { createAuthMiddleware } from './agent/http/middleware/auth'
import { WebhookNotifier } from './integration/webhookNotifier'

const app = express()
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

const auth = createAuthMiddleware(logger)
const webhookNotifier = new WebhookNotifier(logger)

// env snapshot for troubleshooting
logger.info(
  {
    ES_URL: process.env.ES_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    HYBRID_TIMEOUT_MS: process.env.HYBRID_TIMEOUT_MS,
  },
  'env snapshot',
)

const parseJSON = express.json({ limit: '2kb' })

// === Agent endpoints ===
app.post(
  '/agent.search',
  auth,
  parseJSON,
  createAgentSearchHandler(logger, { webhookNotifier }),
)
app.post(
  '/agent.dialog',
  auth,
  parseJSON,
  createAgentDialogHandler(logger, { webhookNotifier }),
)

// Simple auth test endpoint
app.post('/auth-test', auth, (_req, res) => {
  res.json({ ok: true })
})

// === Health / debug ===
app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('/debug/env', (_req, res) => {
  res.json({
    ES_URL: process.env.ES_URL || null,
    DATABASE_URL: process.env.DATABASE_URL || null,
    hasES: Boolean(process.env.ES_URL),
    hasPG: Boolean(process.env.DATABASE_URL),
  })
})

// === Cross-encoder / rerank helpers ===
app.get('/ce/status', auth, (_req, res) => res.json(ceStatus()))

app.post('/ce/warmup', auth, async (_req, res) => {
  const r = await warmupCE()
  res.json(r)
})

// === /search & /search.v1 ===

// v1: schema-validated search with meta (primary endpoint)
app.post('/search.v1', auth, parseJSON, async (req, res) => {
  // Normal mode: schema-validated + rerank
  const schemaIn = z.object({
    q: z.string().min(1),
    topK: z.number().int().positive().max(50).optional(),
  })

  const parsed = schemaIn.safeParse(req.body ?? {})
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_request', details: parsed.error.format() })
  }

  const { q, topK } = parsed.data
  const k = typeof topK === 'number' ? topK : 12

  const routeStr = 'hybrid:es+pg'

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
    logger.error({ error }, 'search.v1 failed')
    return res.status(500).json({
      error: 'internal',
      message: (error as Error).message,
    })
  }
})

// Legacy /search endpoint (kept for compatibility / simple testing)
app.post('/search', auth, parseJSON, async (req, res) => {
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
    logger.error({ error }, 'search failed')
    return res.status(500).json({
      error: 'internal',
      message: (error as Error).message,
    })
  }
})

const port = Number(process.env.PORT || 3000)
app.listen(port, () => {
  logger.info({ port, env: process.env.NODE_ENV }, 'server listening')
})
