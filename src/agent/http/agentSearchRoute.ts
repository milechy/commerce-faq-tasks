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
  useLlmPlanner: z.boolean().optional(),
});

type AgentSearchDeps = {
  webhookNotifier?: WebhookNotifier;
};

type RagStatsCamel = {
  plannerMs?: number;
  searchMs?: number;
  rerankMs?: number;
  answerMs?: number;
  totalMs?: number;
  rerankEngine?: string;
};

function toCamelRagStats(ragStats: any): RagStatsCamel | undefined {
  if (!ragStats || typeof ragStats !== "object") return undefined;

  // ragStats が camelCase / snake_case どちらでも拾えるようにする（移行耐性）
  const getNum = (a: any, b: any) =>
    typeof a === "number" ? a : typeof b === "number" ? b : undefined;

  const getStr = (a: any, b: any) =>
    typeof a === "string" ? a : typeof b === "string" ? b : undefined;

  return {
    plannerMs: getNum(ragStats.plannerMs, ragStats.planner_ms),
    searchMs: getNum(ragStats.searchMs, ragStats.search_ms),
    rerankMs: getNum(ragStats.rerankMs, ragStats.rerank_ms),
    answerMs: getNum(ragStats.answerMs, ragStats.answer_ms),
    totalMs: getNum(ragStats.totalMs, ragStats.total_ms),
    rerankEngine: getStr(ragStats.rerankEngine, ragStats.rerank_engine),
  };
}

/**
 * /agent.search ハンドラ
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
        : "demo";

    try {
      const result = await runSearchAgent({
        q,
        topK,
        debug,
        useLlmPlanner,
        tenantId,
      });

      const durationMs = Date.now() - startedAt;

      const anyResult = result as any;

      // Backward-compat: keep top-level ragStats only when explicitly requested.
      // Default: canonical ragStats is meta.ragStats.
      const keepTopLevelRagStats =
        debug === true ||
        req.header("x-compat-ragstats") === "1" ||
        process.env.RAGSTATS_TOPLEVEL_COMPAT === "1";

      // --- #1: canonical ragStats is meta.ragStats (camelCase) ---
      const camelRagStats = toCamelRagStats(anyResult?.ragStats);

      // base response
      const responseBody: any = {
        ...anyResult,
        meta: {
          ...(anyResult.meta ?? {}),
          tenant_id: tenantId,
          duration_ms: durationMs,
          ...(camelRagStats
            ? {
                ragStats: camelRagStats,
              }
            : {}),
        },
      };

      // Canonical: meta.ragStats
      // Compat: optionally keep top-level ragStats.
      if (camelRagStats) {
        responseBody.meta = {
          ...(responseBody.meta ?? {}),
          deprecated: {
            ...(responseBody.meta?.deprecated ?? {}),
            ...(keepTopLevelRagStats
              ? {}
              : {
                  ragStats:
                    "Top-level ragStats is deprecated. Use meta.ragStats.",
                }),
          },
        };
      }

      if (!keepTopLevelRagStats) {
        delete responseBody.ragStats;
      }

      // --- #2: avoid double meta under debug ---
      if (responseBody?.debug && typeof responseBody.debug === "object") {
        if (Object.prototype.hasOwnProperty.call(responseBody.debug, "meta")) {
          const dbgMeta = (responseBody.debug as any).meta;
          if (dbgMeta != null) {
            responseBody.debug = {
              ...responseBody.debug,
              internalMeta: dbgMeta,
            };
          }
          delete (responseBody.debug as any).meta;
        }
      }

      logger.info(
        {
          event: "agent.search.finished",
          tenantId,
          durationMs,
          ragStats: camelRagStats,
        },
        "agent.search finished"
      );

      res.json(responseBody);
    } catch (err) {
      logger.error({ err }, "agent.search error");
      res.status(500).json({
        error: "internal_error",
        message: "Agent search failed",
      });
    }
  };
}
