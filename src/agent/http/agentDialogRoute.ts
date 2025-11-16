// src/agent/http/agentDialogRoute.ts

import type { Request, Response } from 'express';
import type pino from 'pino';
import { z } from 'zod';
import { runDialogTurn } from '../dialog/dialogAgent';

const DialogMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
});

const DialogOptionsSchema = z.object({
  topK: z.number().int().min(1).max(20).optional(),
  language: z.enum(['ja', 'en', 'auto']).optional(),
  useLlmPlanner: z.boolean().optional(),
  useMultiStepPlanner: z.boolean().optional(),
  mode: z.enum(['local', 'crew']).optional(),
  debug: z.boolean().optional(),
});

const AgentDialogSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
  history: z.array(DialogMessageSchema).optional(),
  options: DialogOptionsSchema.optional(),
});

export function createAgentDialogHandler(logger: pino.Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = AgentDialogSchema.safeParse(req.body);

    if (!parsed.success) {
      logger.warn(
        { errors: parsed.error.format() },
        'agent.dialog invalid request body',
      );
      res.status(400).json({
        error: 'invalid_request',
        message: 'Invalid request body for /agent.dialog',
        details: parsed.error.format(),
      });
      return;
    }

    try {
      const result = await runDialogTurn(parsed.data);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'agent.dialog error');
      res.status(500).json({
        error: 'internal_error',
        message: 'Dialog agent failed',
      });
    }
  };
}