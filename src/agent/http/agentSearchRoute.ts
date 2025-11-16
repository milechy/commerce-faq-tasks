import type { Request, Response } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { runSearchAgent } from '../flow/searchAgent'

const AgentSearchSchema = z.object({
  q: z.string().min(1),
  topK: z.number().int().min(1).max(20).optional(),
  debug: z.boolean().optional(),
  // Planner を LLM 経路にするかどうか（デフォルト false）
  useLlmPlanner: z.boolean().optional(),
})

export function createAgentSearchHandler(logger: pino.Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = AgentSearchSchema.safeParse(req.body)

    if (!parsed.success) {
      res.status(400).json({
        error: 'bad_request',
        message: 'Invalid request body',
        details: parsed.error.issues,
      })
      return
    }

    const { q, topK, debug, useLlmPlanner } = parsed.data

    try {
      const result = await runSearchAgent({
        q,
        topK,
        debug,
        useLlmPlanner,
      })

      res.json(result)
    } catch (err) {
      logger.error({ err }, 'agent.search error')
      res.status(500).json({
        error: 'internal_error',
        message: 'Agent search failed',
      })
    }
  }
}