// src/agent/http/agentSearchRoute.ts
import type { Request, Response } from "express";
import type pino from "pino";
import { z } from "zod";
import type { WebhookNotifier } from "../../integration/webhookNotifier";
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
 * 検索エージェントを実行し、結果を返す。
 * 以前はここから外部 Webhook（n8n）へイベントを送信していたが、現在は無効化している。
 */
export function createAgentSearchHandler(
  logger: pino.Logger,
  deps: AgentSearchDeps = {}
) {
  return async (req: Request, res: Response): Promise<void> => {
    void deps;
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

      res.json(result);
    } catch (err) {
      const durationMs = Date.now() - startedAt;

      logger.error({ err }, "agent.search error");

      res.status(500).json({
        error: "internal_error",
        message: "Agent search failed",
      });
    }
  };
}
