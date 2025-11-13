// src/agent/http/agentSearchRoute.ts

import type { Request, Response } from 'express';
import type pino from 'pino';
import { z } from 'zod';
import { runSearchAgent } from '../flow/searchAgent';

const AgentSearchSchema = z.object({
  q: z.string().min(1, 'q is required'),
  topK: z.number().int().min(1).max(20).optional(),
  debug: z.boolean().optional(),
});

/**
 * /agent.search POST ハンドラ
 */
export function createAgentSearchHandler(logger: pino.Logger) {
  return async function agentSearchHandler(req: Request, res: Response) {
    const parsed = AgentSearchSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues },
        'agent.search: invalid request',
      );
      return res.status(400).json({
        error: 'bad_request',
        message: parsed.error.message,
      });
    }

    const { q, topK, debug } = parsed.data;

    try {
      const result = await runSearchAgent({ q, topK, debug });
      return res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'agent.search failed');
      return res.status(500).json({
        error: 'internal',
        message: (error as Error).message,
      });
    }
  };
}