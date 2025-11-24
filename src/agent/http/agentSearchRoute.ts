// src/agent/http/agentSearchRoute.ts
import type { Request, Response } from "express";
import type pino from "pino";
import { z } from "zod";
import type {
  AgentWebhookEvent,
  WebhookNotifier,
} from "../../integration/webhookNotifier";
import { runSearchAgent } from "../flow/searchAgent";

const AgentSearchSchema = z.object({
  q: z.string().min(1),
  topK: z.number().int().min(1).max(20).optional(),
  debug: z.boolean().optional(),
  // Planner を LLM 経路にするかどうか（デフォルト false）
  useLlmPlanner: z.boolean().optional(),
});

type AgentSearchDeps = {
  webhookNotifier?: WebhookNotifier;
};

/**
 * /agent.search ハンドラ
 *
 * Phase7: WebhookNotifier を受け取り、成功時 / エラー時に
 * agent.search.completed / agent.search.error イベントを n8n に送る。
 */
export function createAgentSearchHandler(
  logger: pino.Logger,
  deps: AgentSearchDeps = {}
) {
  const webhook = deps.webhookNotifier;

  return async (req: Request, res: Response): Promise<void> => {
    const parsed = AgentSearchSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn(
        { errors: parsed.error.format() },
        "agent.search invalid request body"
      );
      res.status(400).json({
        error: "invalid_request",
        message: "Invalid request body for /agent.search",
      });
      return;
    }

    const { q, topK, debug, useLlmPlanner } = parsed.data;
    const startedAt = Date.now();

    const headerTenantId = req.header("x-tenant-id");
    const tenantId =
      headerTenantId && headerTenantId.trim().length > 0
        ? headerTenantId.trim()
        : "demo"; // fallback tenant for local/dev (matches faq_embeddings.tenant_id)

    try {
      const result = await runSearchAgent({
        q,
        topK,
        debug,
        useLlmPlanner,
        tenantId,
      });

      const durationMs = Date.now() - startedAt;

      // 正常系 Webhook
      if (webhook) {
        const event: AgentWebhookEvent = {
          type: "agent.search.completed",
          timestamp: new Date().toISOString(),
          endpoint: "/agent.search",
          latencyMs: durationMs,
          tenantId,
          meta: {
            // n8n 側でモニタリングしやすい軽めの情報だけ載せる
            topK: topK ?? undefined,
            debug: !!debug,
            useLlmPlanner: !!useLlmPlanner,
            // steps 数など簡易な統計（存在しない場合は undefined）
            // result.steps は AgentSearchResponse 型に依存するので any 経由で安全にアクセス
            stepsCount: Array.isArray((result as any).steps)
              ? (result as any).steps.length
              : undefined,
            ragStats: (result as any).ragStats,
          },
        };

        webhook.send(event).catch((err) => {
          logger.warn({ err }, "failed to send agent.search webhook");
        });
      }

      res.json(result);
    } catch (err) {
      const durationMs = Date.now() - startedAt;

      logger.error({ err }, "agent.search error");

      // エラー用 Webhook
      if (deps.webhookNotifier) {
        const errorEvent: AgentWebhookEvent = {
          type: "agent.search.error",
          timestamp: new Date().toISOString(),
          endpoint: "/agent.search",
          latencyMs: durationMs,
          tenantId,
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
            "failed to send agent.search error webhook"
          );
        });
      }

      res.status(500).json({
        error: "internal_error",
        message: "Agent search failed",
      });
    }
  };
}
