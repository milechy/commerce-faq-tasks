import "dotenv/config";

import { Client as NotionClientSdk } from "@notionhq/client";
import express from "express";
import path from "node:path";
import pino from "pino";
import { z } from "zod";
import { runDialogTurn } from "./agent/dialog/dialogAgent";
import { createAgentSearchHandler } from "./agent/http/agentSearchRoute";
import {
  buildClarifyPrompt,
  type ClarifyIntent,
} from "./agent/orchestrator/sales/clarifyPromptBuilder";
import { registerNotionSalesTemplateProvider } from "./agent/orchestrator/sales/notionSalesTemplatesProvider";
import {
  getSalesTemplate,
  type SalesPhase,
} from "./agent/orchestrator/sales/salesRules";
import { createNotionSalesLogSink } from "./integration/notion/notionSalesLogSink";
import {
  SalesLogWriter,
  setGlobalSalesLogWriter,
} from "./integration/notion/salesLogWriter";
import { ClarifyLogWriter } from "./integrations/notion/clarifyLogWriter";
import { NotionSyncService } from "./integrations/notion/notionSyncService";
import { hybridSearch } from "./search/hybrid";
import {
  ceFlagFromRerankResult,
  ceStatus,
  rerank,
  warmupCE,
} from "./search/rerank";

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

app.use(express.json({ limit: "1mb" }));

// --- minimal internal UI ---
// Serve static assets from /public (no CORS needed; same-origin)
const publicDir = path.resolve(process.cwd(), "public");
app.use(express.static(publicDir));

// Convenience: /ui -> /ui/index.html
app.get("/ui", (_req, res) => res.redirect("/ui/index.html"));

const clarifyLogWriter = new ClarifyLogWriter();

// Phase14: SalesLogWriter (Notion) initialization
const notionSalesLogDatabaseId = process.env.NOTION_DB_SALES_LOGS_ID;
if (process.env.NOTION_API_KEY && notionSalesLogDatabaseId) {
  const notionClient = new NotionClientSdk({
    auth: process.env.NOTION_API_KEY,
  });

  const salesLogSink = createNotionSalesLogSink({
    notion: notionClient,
    databaseId: notionSalesLogDatabaseId,
  });

  const writer = new SalesLogWriter(salesLogSink);
  setGlobalSalesLogWriter(writer);
  logger.info("[startup] SalesLogWriter initialized for Notion");
} else {
  setGlobalSalesLogWriter(undefined);
  logger.warn(
    "[startup] SalesLogWriter not initialized (missing NOTION_API_KEY or NOTION_DB_SALES_LOGS_ID)"
  );
}

// env snapshot for troubleshooting
logger.info({
  ES_URL: process.env.ES_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  HYBRID_TIMEOUT_MS: process.env.HYBRID_TIMEOUT_MS,
});

// --- agent endpoints ---
// /agent.search (dot) is the canonical route.
app.post("/agent.search", createAgentSearchHandler(logger));

// Compatibility alias (slash). Some clients/frameworks have trouble with dots in paths.
app.post("/agent/search", createAgentSearchHandler(logger));

// --- CE endpoints (for troubleshooting) ---
// NOTE: GET /ce/status must be side-effect free.
app.get("/ce/status", (_req, res) => {
  return res.json(ceStatus());
});

// Explicit warmup to load the CE model (if ONNX).
app.post("/ce/warmup", async (_req, res) => {
  try {
    const out = await warmupCE();
    return res.json(out);
  } catch (error) {
    logger.error({ error }, "[ce] warmup failed");
    return res.status(500).json({ ok: false, error: "warmup_failed" });
  }
});

// --- search endpoints ---

// Simple search endpoint
app.post("/search", async (req, res) => {
  const schema = z.object({ q: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const { q } = parsed.data;

  try {
    const results = await hybridSearch(q);
    const re = await rerank(q, results.items, 12);
    return res.json({
      ...results,
      items: re.items,
      ce_ms: re.ce_ms,
      engine: re.engine,
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// v1: schema-validated search with meta
app.post("/search.v1", async (req, res) => {
  const schemaIn = z.object({
    q: z.string(),
    topK: z.number().int().positive().max(50).optional(),
  });

  const parsed = schemaIn.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_request", details: parsed.error.issues });
  }

  const { q, topK } = parsed.data;
  const k = typeof topK === "number" ? topK : 12;

  const startedAt = Date.now();
  const routeStr = "hybrid:es50+pg50";

  try {
    const tSearch0 = Date.now();
    const results = await hybridSearch(q);
    const tSearch1 = Date.now();
    const search_ms = Math.max(0, tSearch1 - tSearch0);

    const tRerank0 = Date.now();
    const re = await rerank(q, results.items, k);
    const tRerank1 = Date.now();
    const rerank_ms = Math.max(0, tRerank1 - tRerank0);

    const duration_ms = Math.max(0, Date.now() - startedAt);

    const flags: string[] = ["v1", "validated", ceFlagFromRerankResult(re)];
    if (re.engine === "ce+fallback") flags.push("ce:fallback");

    const hybrid_note = (results as any)?.note;

    return res.json({
      ...results,
      items: re.items,
      ce_ms: re.ce_ms,
      // Explicit engine label for troubleshooting (heuristic / ce / ce+fallback)
      engine: re.engine,
      meta: {
        tenant_id: (results as any)?.meta?.tenant_id ?? undefined,
        route: routeStr,
        duration_ms,
        flags,
        note: hybrid_note,
        ragStats: {
          plannerMs: 0,
          searchMs: search_ms,
          rerankMs: rerank_ms,
          answerMs: 0,
          totalMs: duration_ms,
          rerankEngine: re.engine,
          // Backward-compat: some clients expect snake_case.
          rerank_engine: re.engine,
        },
      },
    });
  } catch (error) {
    logger.error({ error }, "[search.v1] internal error");
    return res
      .status(500)
      .json({ error: "internal", message: (error as Error).message });
  }
});

// --- dialog (multi-step planner + orchestrator + sales) endpoint ---
app.post("/dialog/turn", async (req, res) => {
  const schemaIn = z.object({
    message: z.string(),
    sessionId: z.string().optional(),
    options: z
      .object({
        topK: z.number().int().positive().max(50).optional(),
        language: z.enum(["ja", "en", "auto"]).optional(),
        useMultiStepPlanner: z.boolean().optional(),
        useLlmPlanner: z.boolean().optional(),
        personaTags: z.array(z.string()).optional(),
        debug: z.boolean().optional(),
      })
      .optional(),
  });

  const parsed = schemaIn.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      details: parsed.error.issues,
    });
  }

  try {
    const turn = await runDialogTurn(parsed.data);
    return res.json(turn);
  } catch (error) {
    logger.error({ error }, "[dialog] failed to run dialog turn");
    return res.status(500).json({ error: "internal_error" });
  }
});

// --- sales template debug endpoint ---
app.post("/sales/debug/template", (req, res) => {
  const schema = z.object({
    phase: z.enum(["clarify", "propose", "recommend", "close"]),
    intent: z.string().optional(),
    personaTags: z.array(z.string()).optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_request", details: parsed.error.issues });
  }

  const { phase, intent, personaTags } = parsed.data as {
    phase: SalesPhase;
    intent?: string;
    personaTags?: string[];
  };

  const tmpl = getSalesTemplate({ phase, intent, personaTags });

  if (!tmpl) {
    return res.status(404).json({ found: false });
  }

  return res.json({
    found: true,
    template: tmpl,
  });
});

// --- clarify prompt debug endpoint (uses Notion + fallback) ---
app.post("/sales/debug/clarify", (req, res) => {
  const schema = z.object({
    intent: z.enum(["level_diagnosis", "goal_setting"]),
    personaTags: z.array(z.string()).optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid_request", details: parsed.error.issues });
  }

  const { intent, personaTags } = parsed.data as {
    intent: ClarifyIntent;
    personaTags?: string[];
  };

  const prompt = buildClarifyPrompt({ intent, personaTags });

  return res.json({
    intent,
    personaTags: personaTags ?? [],
    prompt,
  });
});

// --- clarify log write-back endpoint (Phase13: MVP) ---
app.post("/integrations/notion/clarify-log", async (req, res) => {
  const schema = z.object({
    originalQuestion: z.string(),
    clarifyQuestion: z.string(),
    missingInfo: z.string().optional(),
    intent: z.string().optional(),
    tenantId: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      details: parsed.error.issues,
    });
  }

  try {
    await clarifyLogWriter.createLog(parsed.data);
    return res.json({ ok: true });
  } catch (error) {
    logger.error({ error }, "[clarify-log] failed to create clarify log");
    return res.status(500).json({ error: "internal_error" });
  }
});

const port = Number(process.env.PORT || 3000);

async function startServer() {
  // Phase13: initialize sales templates from Notion (best-effort)
  logger.info("[startup] initializing sales templates from Notion");

  try {
    const notionSync = new NotionSyncService();
    logger.info("[startup] NotionSyncService created");

    const templates = await notionSync.syncTuningTemplates();
    logger.info(
      { count: templates.length },
      "[startup] tuning templates synced from Notion"
    );

    try {
      if (templates.length > 0) {
        registerNotionSalesTemplateProvider(templates);
        logger.info(
          { count: templates.length },
          "[startup] sales templates provider registered"
        );
      } else {
        logger.warn("[startup] no tuning templates loaded from Notion");
      }
    } catch (error) {
      logger.error(
        {
          errorStage: "registerNotionSalesTemplateProvider",
          errorMessage: (error as any)?.message,
          errorStack: (error as any)?.stack,
          errorRaw: error,
        },
        "failed to register sales templates provider"
      );
    }
  } catch (error) {
    logger.error(
      {
        errorStage: "syncTuningTemplates",
        errorMessage: (error as any)?.message,
        errorStack: (error as any)?.stack,
        errorRaw: error,
      },
      "failed to initialize sales templates from Notion"
    );
  }

  app.listen(port, () => {
    logger.info({ port, env: process.env.NODE_ENV }, "server listening");
  });
}

startServer().catch((error) => {
  logger.error({ error }, "fatal error during server startup");
  process.exit(1);
});
