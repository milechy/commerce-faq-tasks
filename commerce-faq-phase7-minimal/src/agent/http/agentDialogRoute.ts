import type { Request, Response } from "express";
import type pino from "pino";
import { z } from "zod";
import {
  GroqRateLimitError,
  getGroqGlobalBackoffRemainingMs,
} from "../llm/groqClient";
import { runDialogTurn } from "../dialog/dialogAgent";
import { runDialogGraph } from "../orchestrator/langGraphOrchestrator";
import type {
  AgentWebhookEvent,
  WebhookNotifier,
} from "../../integration/webhookNotifier";

const DialogMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
});

const DialogOptionsSchema = z.object({
  topK: z.number().int().min(1).max(20).optional(),
  language: z.enum(["ja", "en", "auto"]).optional(),
  useLlmPlanner: z.boolean().optional(),
  useMultiStepPlanner: z.boolean().optional(),
  mode: z.enum(["local", "crew"]).optional(),
  debug: z.boolean().optional(),
});

const AgentDialogSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
  history: z.array(DialogMessageSchema).optional(),
  options: DialogOptionsSchema.optional(),
});

type AgentDialogDeps = {
  webhookNotifier?: WebhookNotifier;
};

export function createAgentDialogHandler(
  logger: pino.Logger,
  deps: AgentDialogDeps = {},
) {
  const webhook = deps.webhookNotifier;

  return async (req: Request, res: Response): Promise<void> => {
    const parsed = AgentDialogSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { errors: parsed.error.format() },
        "agent.dialog invalid request body",
      );
      res.status(400).json({
        error: "invalid_request",
        message: "Invalid request body for /agent.dialog",
        details: parsed.error.format(),
      });
      return;
    }

    const startedAt = Date.now();
    const data = parsed.data;
    const useLangGraph =
      (process.env.DIALOG_ORCHESTRATOR_MODE ?? "langgraph") === "langgraph";

    logger.info(
      {
        envMode: process.env.DIALOG_ORCHESTRATOR_MODE,
        useLangGraph,
      },
      "agent.dialog orchestrator mode decision",
    );

    let langgraphError: unknown = null;
    let groq429Fallback = false;

    try {
      if (useLangGraph) {
        try {
          // Phase4: Groq + LangGraph ベースの新 Orchestrator 経由で処理する
          const language = data.options?.language ?? "ja";
          const locale = language === "auto" ? "ja" : language;
          const history = (data.history ?? []).filter(
            (m): m is { role: "user" | "assistant"; content: string } =>
              m.role === "user" || m.role === "assistant",
          );

          const output = await runDialogGraph({
            tenantId: "default", // TODO: 実際のテナント解決ロジックに差し替え
            userMessage: data.message,
            locale: locale as "ja" | "en",
            conversationId: data.sessionId ?? "unknown-session",
            history,
          });
          const plan = output.plannerPlan;

          const durationMs = Date.now() - startedAt;

          logger.info(
            {
              sessionId: data.sessionId ?? "unknown-session",
              locale,
              route: output.route,
              plannerReasons: output.plannerReasons,
              safetyTag: output.safetyTag,
              requiresSafeMode: output.requiresSafeMode,
              hasPlan: !!plan,
              needsClarification: plan?.needsClarification ?? false,
              durationMs,
              ragStats: output.ragStats,
              ragSearchMs: output.ragStats?.search_ms,
              ragRerankMs: output.ragStats?.rerank_ms,
              ragTotalMs: output.ragStats?.total_ms,
            },
            "agent.dialog langgraph routing summary",
          );

          // Webhook 通知（LangGraph 成功時）
          if (webhook) {
            const event: AgentWebhookEvent = {
              type: "agent.dialog.completed",
              timestamp: new Date().toISOString(),
              endpoint: "/agent.dialog",
              latencyMs: durationMs,
              tenantId: "default",
              meta: {
                orchestratorMode: "langgraph",
                route: output.route,
                groq429Fallback: false,
                hasLanggraphError: false,
                groqBackoffRemainingMs: getGroqGlobalBackoffRemainingMs(),
                ragStats: output.ragStats,
                needsClarification: plan?.needsClarification ?? false,
              },
            };

            webhook.send(event).catch((err) => {
              logger.warn({ err }, "failed to send agent.dialog webhook (langgraph)");
            });
          }

          res.json({
            sessionId: data.sessionId,
            answer: output.text,
            // PlannerPlan 本体をそのまま公開（id/type/description/... を含む）
            // - Phase9 以降、フロントでは steps だけでなく plannerPlan 全体も参照できるようにする
            plannerPlan: plan ?? null,
            // PlannerPlan の steps をそのまま公開
            steps: plan?.steps ?? [],
            // SalesPipeline / SalesRules による判定結果メタ情報
            // - Phase9 では pipelineKind や upsell/cta のフラグなどをここに含める想定
            salesMeta: output.salesMeta ?? null,
            // needsClarification が true の場合はフロント互換で final=false にする
            final: !(plan?.needsClarification ?? false),
            needsClarification: plan?.needsClarification ?? false,
            clarifyingQuestions: plan?.clarifyingQuestions ?? [],
            meta: {
              route: output.route,
              plannerReasons: output.plannerReasons,
              orchestratorMode: "langgraph",
              safetyTag: output.safetyTag,
              requiresSafeMode: output.requiresSafeMode,
              ragStats: output.ragStats,
            },
          });
          return;
        } catch (err) {
          // LangGraph 経由の処理に失敗した場合は、ログを残してローカルの dialogAgent にフォールバックする
          langgraphError = err;

          if (err instanceof GroqRateLimitError) {
            groq429Fallback = true;
            logger.warn(
              {
                err,
                retryAfterMs: err.retryAfterMs,
                status: err.status,
              },
              "agent.dialog langgraph orchestrator hit Groq 429, falling back to local",
            );
          } else {
            logger.error(
              { err },
              "agent.dialog langgraph orchestrator failed, falling back to local",
            );
          }
        }
      }

      // Phase3: 既存のローカル dialogAgent 経由で処理する
      const result = await runDialogTurn(data);

      if (langgraphError && result && typeof result === "object") {
        const safeMessage =
          langgraphError instanceof Error
            ? langgraphError.message
            : typeof langgraphError === "string"
            ? langgraphError
            : "unknown langgraph error";

        const meta = (result as any).meta ?? {};
        const orchestratorMode = groq429Fallback
          ? "fallback-local-429"
          : meta.orchestratorMode ?? "local";

        (result as any).meta = {
          ...meta,
          orchestratorMode,
          langgraphError: safeMessage,
        };
      }

      const finalMeta = (result as any)?.meta ?? {};
      const groqBackoffRemainingMs = getGroqGlobalBackoffRemainingMs();
      const durationMs = Date.now() - startedAt;

      // Webhook 通知（正常完了 / フォールバック）
      if (webhook) {
        const event: AgentWebhookEvent = {
          type: groq429Fallback
            ? "agent.dialog.fallback"
            : "agent.dialog.completed",
          timestamp: new Date().toISOString(),
          endpoint: "/agent.dialog",
          latencyMs: durationMs,
          tenantId: "default",
          meta: {
            orchestratorMode:
              finalMeta.orchestratorMode ??
              (useLangGraph ? "langgraph" : "local"),
            route: finalMeta.route ?? "20b",
            groq429Fallback,
            hasLanggraphError: !!langgraphError,
            groqBackoffRemainingMs,
            ragStats: finalMeta.ragStats,
            needsClarification: finalMeta.needsClarification ?? false,
          },
        };

        webhook.send(event).catch((err) => {
          logger.warn({ err }, "failed to send agent.dialog webhook");
        });
      }

      logger.info(
        {
          sessionId: data.sessionId ?? "unknown-session",
          locale: data.options?.language ?? "ja",
          orchestratorMode:
            finalMeta.orchestratorMode ??
            (useLangGraph ? "langgraph" : "local"),
          route: finalMeta.route ?? "20b",
          groq429Fallback,
          hasLanggraphError: !!langgraphError,
          groqBackoffRemainingMs,
          durationMs,
        },
        "agent.dialog final summary",
      );

      res.json(result);
    } catch (err) {
      logger.error({ err }, "agent.dialog error");

      const durationMs = Date.now() - startedAt;

      if (deps.webhookNotifier) {
        const errorEvent: AgentWebhookEvent = {
          type: "agent.dialog.error",
          timestamp: new Date().toISOString(),
          endpoint: "/agent.dialog",
          latencyMs: durationMs,
          tenantId: "default",
          error: {
            name: err instanceof Error ? err.name : "Error",
            message:
              err instanceof Error ? err.message : String(err ?? "unknown"),
            stack: err instanceof Error && err.stack ? err.stack : undefined,
          },
        };
        deps.webhookNotifier.send(errorEvent).catch((sendErr) => {
          logger.warn(
            { err: sendErr },
            "failed to send agent.dialog error webhook",
          );
        });
      }

      res.status(500).json({
        error: "internal_error",
        message: "Dialog agent failed",
      });
    }
  };
}
