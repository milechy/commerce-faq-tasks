import type { Request, Response } from 'express';
import type pino from 'pino';
import { z } from 'zod';
import { runDialogTurn } from '../dialog/dialogAgent';
import { runDialogGraph } from '../orchestrator/langGraphOrchestrator';

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

    const startedAt = Date.now();
    const data = parsed.data;
    const useLangGraph =
      (process.env.DIALOG_ORCHESTRATOR_MODE ?? 'langgraph') === 'langgraph';

    logger.info(
      {
        envMode: process.env.DIALOG_ORCHESTRATOR_MODE,
        useLangGraph,
      },
      'agent.dialog orchestrator mode decision',
    );

    let langgraphError: unknown = null;

    try {
      if (useLangGraph) {
        try {
          // Phase4: Groq + LangGraph ベースの新 Orchestrator 経由で処理する
          const language = data.options?.language ?? 'ja';
          const locale = language === 'auto' ? 'ja' : language;
          const history = (data.history ?? []).filter(
            (m): m is { role: 'user' | 'assistant'; content: string } =>
              m.role === 'user' || m.role === 'assistant',
          );

          const output = await runDialogGraph({
            tenantId: 'default', // TODO: 実際のテナント解決ロジックに差し替え
            userMessage: data.message,
            locale: locale as 'ja' | 'en',
            conversationId: data.sessionId ?? 'unknown-session',
            history,
          });
          const plan = output.plannerPlan;

          // Phase4: safety / routing 情報を pino に構造化ログとして残す
          logger.info(
            {
              sessionId: data.sessionId ?? 'unknown-session',
              locale,
              route: output.route,
              plannerReasons: output.plannerReasons,
              safetyTag: output.safetyTag,
              requiresSafeMode: output.requiresSafeMode,
              hasPlan: !!plan,
              needsClarification: plan?.needsClarification ?? false,
              durationMs: Date.now() - startedAt,
            },
            'agent.dialog langgraph routing summary',
          );

          res.json({
            sessionId: data.sessionId,
            answer: output.text,
            // PlannerPlan の steps をそのまま公開（id/type/description/... を含む）
            steps: plan?.steps ?? [],
            // needsClarification が true の場合はフロント互換で final=false にする
            final: !(plan?.needsClarification ?? false),
            needsClarification: plan?.needsClarification ?? false,
            clarifyingQuestions: plan?.clarifyingQuestions ?? [],
            meta: {
              route: output.route,
              plannerReasons: output.plannerReasons,
              orchestratorMode: 'langgraph',
              safetyTag: output.safetyTag,
              requiresSafeMode: output.requiresSafeMode,
            },
          });
          return;
        } catch (err) {
          // LangGraph 経由の処理に失敗した場合は、ログを残してローカルの dialogAgent にフォールバックする
          langgraphError = err;
          logger.error(
            { err },
            'agent.dialog langgraph orchestrator failed, falling back to local',
          );
        }
      }

      // Phase3: 既存のローカル dialogAgent 経由で処理する
      const result = await runDialogTurn(data);

      if (langgraphError && result && typeof result === 'object') {
        const safeMessage =
          langgraphError instanceof Error
            ? langgraphError.message
            : typeof langgraphError === 'string'
            ? langgraphError
            : 'unknown langgraph error';

        const meta = (result as any).meta ?? {};
        (result as any).meta = { ...meta, langgraphError: safeMessage };
      }

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