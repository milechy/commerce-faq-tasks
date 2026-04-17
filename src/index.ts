import "dotenv/config";
import "./config/env";

import { pool as db } from "./lib/db";
import { alertEngine } from "./lib/alerts/alertEngine";
import express from "express";
import multer from "multer";
import path from "node:path";
import pino from "pino";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { AuthedRequest } from "./agent/http/authMiddleware";
import { runOcrPipeline } from "./lib/ocrPipeline";
import { INTERNAL_REQUEST_HEADER } from "./lib/metrics/kpiDefinitions";
import { metricsRegistry } from "./lib/metrics/promExporter";
import { createChatHandler } from "./api/chat/route";
import { healthHandler } from "./lib/health";
import { runDialogTurn } from "./agent/dialog/dialogAgent";
import { initAuthMiddleware } from "./agent/http/authMiddleware";
import { createAgentSearchHandler } from "./agent/http/agentSearchRoute";
import { createCorsMiddleware } from "./lib/cors";
import { securityHeadersMiddleware } from "./lib/headers";
import { createRateLimitMiddleware } from "./lib/rate-limit";
import { requestIdMiddleware } from "./lib/request-id";
import { createSecurityPolicyMiddleware } from "./lib/security-policy";
import {
  createTenantContextMiddleware,
  getTenantByApiKeyHash,
  seedTenantsFromEnv,
} from "./lib/tenant-context";
import { registerKnowledgeAdminRoutes } from "./api/admin/knowledge/routes";
import { registerKnowledgeGapRoutes } from "./api/admin/knowledge/knowledgeGapRoutes";
import { registerFeedbackRoutes } from "./api/admin/feedback/feedbackRoutes";
import { registerAdminFeedbackManagementRoutes } from "./api/admin/feedback/routes";
import { registerAdminAiAssistRoutes } from "./api/admin/ai-assist/routes";
import { registerFaqAdminRoutes } from "./admin/http/faqAdminRoutes";
import { registerTenantAdminRoutes } from "./api/admin/tenants/routes";
import { registerChatTestRoutes } from "./api/admin/chatTest/routes";
import { registerMonitoringRoutes } from "./api/admin/monitoring/routes";
import { registerChatHistoryRoutes } from "./api/admin/chat-history/routes";
import { registerTuningRoutes } from "./api/admin/tuning/routes";
import { registerTestResponseRoutes } from "./api/admin/tuning/testResponseRoutes";
import { registerAvatarConfigRoutes } from "./api/admin/avatar/routes";
import { registerBillingAdminRoutes } from "./lib/billing/billingApi";
import { createStripeWebhookHandler } from "./lib/billing/stripeWebhook";
import { initUsageTracker } from "./lib/billing/usageTracker";
import { reportUsageToStripe } from "./lib/billing/stripeSync";
import { supabaseAuthMiddleware } from "./admin/http/supabaseAuthMiddleware";
import { superAdminMiddleware } from "./api/admin/tenants/superAdminMiddleware";
import { langDetectMiddleware } from "./api/middleware/langDetect";
import { createOriginCheckMiddleware } from "./api/middleware/originCheck";
import { registerWidgetRoutes } from "./api/widget/routes";
import { registerAuthRoutes } from "./api/auth/routes";
import { registerLiveKitTokenRoutes } from "./api/avatar/livekitTokenRoutes";
import { registerAnamRoutes } from "./api/avatar/anamRoutes";
import { registerAnamChatStreamRoutes } from "./api/avatar/anamChatStreamRoutes";
import { registerFishTtsRoutes } from "./api/avatar/fishTtsRoutes";
import { registerAvatarGenerationRoutes } from "./api/admin/avatar/generationRoutes";
import { registerFalGenerationRoutes } from "./api/admin/avatar/falGenerationRoutes";
import { registerPremiumGenerationRoutes } from "./api/admin/avatar/premiumGenerationRoutes";
import { registerInternalUsageRoutes } from "./api/internal/usageRoutes";
import { registerInternalAvatarConfigRoutes } from "./api/internal/avatarConfigRoutes";
import { registerEvaluationRoutes } from "./api/admin/evaluations/routes";
import { registerVariantRoutes } from "./api/admin/variants/routes";
import { registerObjectionPatternRoutes } from "./api/admin/objection-patterns/routes";
import { registerReportRoutes } from "./api/admin/reports/routes";
import { registerAnalyticsRoutes } from "./api/admin/analytics/routes";
import { registerEventAnalyticsRoutes } from "./api/admin/analytics/eventAnalyticsRoutes";
import { registerEventRoutes } from "./api/events/eventRoutes";
import { registerEngagementRoutes } from "./api/engagement/engagementRoutes";
import { registerConversionRoutes } from "./api/conversion/conversionRoutes";
import { registerAbTestRoutes } from "./api/conversion/abTestRoutes";
import { registerKnowledgeGapPhase46Routes } from "./api/admin/knowledge-gaps/routes";
import { registerNotificationRoutes } from "./api/admin/notifications/routes";
import { registerOptionRoutes } from "./api/admin/options/routes";
import { roleAuthMiddleware, requireRole } from "./api/middleware/roleAuth";
import { hybridSearch } from "./search/hybrid";
import {
  ceFlagFromRerankResult,
  ceStatus,
  rerank,
  warmupCE,
} from "./search/rerank";

const app = express();
app.disable("x-powered-by");
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Phase42: anamRoutes が app.locals.db 経由で pool を参照する
app.locals.db = db;

// ---------------------------------------------------------------------------
// Seed tenant registry (env / JSON) — must run before middleware init
// ---------------------------------------------------------------------------
seedTenantsFromEnv();

// ---------------------------------------------------------------------------
// Global middleware (applied to ALL requests, order matters)
// ---------------------------------------------------------------------------
app.use(requestIdMiddleware);
app.use(securityHeadersMiddleware);
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// CORS — must be global so OPTIONS preflight is handled before route matching.
// app.post() only matches POST; OPTIONS needs app.use() to reach corsMiddleware.
// ---------------------------------------------------------------------------
const defaultOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [];

const corsMiddleware = createCorsMiddleware({
  defaultAllowedOrigins: defaultOrigins,
  logger,
});
app.use(corsMiddleware);

// ---------------------------------------------------------------------------
// Middleware chain — 4-layer security stack (CORS is now global)
//   1. rateLimiter   → global DDoS / flood protection (pre-auth, IP/anon key)
//   2. auth          → JWT / API Key / Basic → tenantId
//   3. tenantContext  → load TenantConfig into req
//   4. securityPolicy → per-tenant origin / policy enforcement
// ---------------------------------------------------------------------------
const globalRateLimiter = createRateLimitMiddleware({ logger });
const authMiddleware = initAuthMiddleware({
  resolveByApiKeyHash: getTenantByApiKeyHash,
});
const tenantContext = createTenantContextMiddleware({ logger });
const securityPolicy = createSecurityPolicyMiddleware({ logger });
const originCheck = createOriginCheckMiddleware(db, { logger });

// --- minimal internal UI (no auth required) ---
const publicDir = path.resolve(process.cwd(), "public");
app.use(
  (_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://cdn.leonardo.ai",
        "connect-src 'self' https://api.r2c.biz wss://*.livekit.cloud",
        "media-src 'self' https: blob:",
      ].join("; ")
    );
    // widget.js はデプロイのたびに変わるため必ず再取得させる
    if (_req.path === "/widget.js") {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    }
    next();
  },
  express.static(publicDir)
);
app.get("/ui", (_req, res) => res.redirect("/ui/index.html"));
// Phase65: 旧demoページから新構成への後方互換リダイレクト
app.get("/carnation-demo.html", (_req, res) => res.redirect(301, "/carnation-demo/index.html"));

// CE status is public (side-effect free)
app.get("/ce/status", (_req, res) => {
  return res.json(ceStatus());
});

// Health check — public, no sensitive data returned
app.get("/health", healthHandler);

// Prometheus metrics — 内部ネットワーク専用（X-Internal-Request: 1 必須）
app.get("/metrics", async (req, res) => {
  if (req.headers[INTERNAL_REQUEST_HEADER] !== "1") {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    const output = await metricsRegistry.metrics();
    res.set("Content-Type", metricsRegistry.contentType);
    return res.end(output);
  } catch (error) {
    logger.error({ error }, "[metrics] failed to collect metrics");
    return res.status(500).json({ error: "metrics_collection_failed" });
  }
});

// ---------------------------------------------------------------------------
// Protected API routes — full middleware chain applied
// ---------------------------------------------------------------------------
const apiStack = [
  globalRateLimiter,     // 1. Rate limit
  authMiddleware,        // 2. Auth → tenantId
  tenantContext,         // 3. Load TenantConfig
  securityPolicy,        // 4. Per-tenant policy (in-memory allowedOrigins)
  originCheck,           // 5. DB-backed per-tenant Origin check
  langDetectMiddleware,  // 6. Phase33: Accept-Language → req.lang
] as express.RequestHandler[];

logger.info({
  ES_URL: process.env.ES_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  HYBRID_TIMEOUT_MS: process.env.HYBRID_TIMEOUT_MS,
});

// --- chat endpoint ---
app.post("/api/chat", ...apiStack, createChatHandler(logger));

// --- agent endpoints ---
app.post("/agent.search", ...apiStack, createAgentSearchHandler(logger));
app.post("/agent/search", ...apiStack, createAgentSearchHandler(logger));

// CE warmup (internal — protected)
app.post("/ce/warmup", ...apiStack, async (_req, res) => {
  try {
    const out = await warmupCE();
    return res.json(out);
  } catch (error) {
    logger.error({ error }, "[ce] warmup failed");
    return res.status(500).json({ ok: false, error: "warmup_failed" });
  }
});

// --- search endpoints (protected) ---

app.post("/search", ...apiStack, async (req, res) => {
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
app.post("/search.v1", ...apiStack, async (req, res) => {
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
app.post("/dialog/turn", ...apiStack, async (req, res) => {
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


// ---------------------------------------------------------------------------
// Admin: PDF OCR upload (v1)
// ---------------------------------------------------------------------------

interface OcrJobStatus {
  status: "processing" | "done" | "failed";
  pages?: number;
  chunks?: number;
  error?: string;
}
const ocrJobs = new Map<string, OcrJobStatus>();
const OCR_JOBS_MAX = 100;
const OCR_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Map 上限超過時に最古エントリを削除する */
function pruneOcrJobs(): void {
  if (ocrJobs.size >= OCR_JOBS_MAX) {
    const oldestKey = ocrJobs.keys().next().value;
    if (oldestKey !== undefined) {
      ocrJobs.delete(oldestKey);
    }
  }
}

/** 完了/失敗ジョブを TTL 後に自動削除する */
function scheduleOcrJobCleanup(jobId: string): void {
  setTimeout(() => ocrJobs.delete(jobId), OCR_JOB_TTL_MS);
}

// [P1-1] PDF マジックナンバー: %PDF-
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("PDFファイルのみアップロードできます。") as unknown as null, false);
    }
  },
});

// POST /v1/admin/knowledge/pdf — JWT 認証 → Super Admin専用 → tenantId 取得 → バックグラウンド OCR
app.post(
  "/v1/admin/knowledge/pdf",
  ...apiStack,
  supabaseAuthMiddleware,
  roleAuthMiddleware,
  requireRole("super_admin"),
  pdfUpload.single("file"),
  async (req: express.Request, res: express.Response): Promise<void> => {
    const tenantId = (req as AuthedRequest).tenantId;
    const target: string = (req.body?.target as string | undefined) || tenantId;

    // "global" は super_admin のみ許可
    if (target === "global" && (req as any).user?.role !== "super_admin") {
      res.status(403).json({ error: "グローバルナレッジはSuper Adminのみ登録可能です" });
      return;
    }

    if (!req.file) {
      res
        .status(400)
        .json({ error: "ファイルが見つかりません。PDFをアップロードしてください。" });
      return;
    }

    // [P1-1] マジックナンバー検証 — MIME 偽装対策
    if (!req.file.buffer.subarray(0, 5).equals(PDF_MAGIC)) {
      res
        .status(400)
        .json({ error: "無効なファイル形式です。PDFファイルをアップロードしてください。" });
      return;
    }

    // [P1-2] Map 上限チェック
    pruneOcrJobs();

    const jobId = uuidv4();
    ocrJobs.set(jobId, { status: "processing" });

    const pdfBuffer = req.file.buffer;

    // バックグラウンド実行 (fire-and-forget)
    void (async () => {
      try {
        const result = await runOcrPipeline(pdfBuffer, target);
        ocrJobs.set(jobId, { status: "done", ...result });
        scheduleOcrJobCleanup(jobId); // [P1-2] TTL 30分
        logger.info({ jobId, tenantId, target, ...result }, "[ocr] pipeline completed");
      } catch (err) {
        const message =
          err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
        logger.error({ jobId, tenantId, target, error: message }, "[ocr] pipeline failed");
        ocrJobs.set(jobId, { status: "failed", error: message });
        scheduleOcrJobCleanup(jobId); // [P1-2] TTL 30分
      }
    })();

    res.status(202).json({ jobId, status: "processing" });
  }
);

// GET /v1/admin/knowledge/jobs/:jobId — ジョブステータス確認
app.get(
  "/v1/admin/knowledge/jobs/:jobId",
  ...apiStack,
  (req: express.Request, res: express.Response): void => {
    const { jobId } = req.params;
    const job = ocrJobs.get(jobId);

    if (!job) {
      res.status(404).json({ error: "ジョブが見つかりません。" });
      return;
    }

    res.json(job);
  }
);

const port = Number(process.env.PORT || 3000);

// Legacy FAQ admin routes (/admin/faqs)
registerFaqAdminRoutes(app);

// Phase29: ナレッジ管理API
registerKnowledgeAdminRoutes(app);

// Phase31: テナント管理API
if (db) registerTenantAdminRoutes(app, db);

// Phase32: 課金管理API
if (db) initUsageTracker(db, logger);

// Stripe Webhook（raw body 必須 — express.json より前にマッチさせること）
app.post(
  "/v1/billing/webhook",
  express.raw({ type: "application/json" }),
  createStripeWebhookHandler(db, logger)
);

// 課金管理API（super_admin / client_admin）
// ロール検査は registerBillingAdminRoutes 内部で行うため supabaseAuthMiddleware のみ渡す
if (db) {
  registerBillingAdminRoutes(app, db, logger, [supabaseAuthMiddleware]);
}

// Phase34: 認証情報API
registerAuthRoutes(app, db);
registerChatTestRoutes(app);
registerMonitoringRoutes(app);

// Phase38: 会話履歴 + チューニングルール API
registerChatHistoryRoutes(app);
registerTuningRoutes(app);
registerTestResponseRoutes(app);
// Phase38+: ナレッジギャップ検出 API
registerKnowledgeGapRoutes(app);
// Phase46 Stream B: Knowledge Gap 推薦・ナレッジ追加 API
registerKnowledgeGapPhase46Routes(app);
// Phase43: admin_feedback チケット管理 API（feedbackRoutes.ts より前に登録）
registerAdminFeedbackManagementRoutes(app);
registerAdminAiAssistRoutes(app);

// Phase45: 評価API + KPI API
registerEvaluationRoutes(app);
// Phase46: Variant CRUD + Objection Patterns + Weekly Reports API
registerVariantRoutes(app);
registerObjectionPatternRoutes(app);
registerReportRoutes(app);
registerAnalyticsRoutes(app);
// Phase55: 行動イベント分析 API
registerEventAnalyticsRoutes(app);
// Phase52h: In-App通知センター API
registerNotificationRoutes(app);
// Phase61: オプションサービス発注 API
registerOptionRoutes(app);
// フィードバックチャット API
registerFeedbackRoutes(app);

// Avatar: Widget → LiveKit Room トークン発行 API
registerLiveKitTokenRoutes(app, apiStack);

// Phase42: Avatar → Anam.ai セッショントークン発行 API
registerAnamRoutes(app, apiStack);
// Phase42: Avatar → Anam Client-Side Custom LLM (Groqストリーミング)
registerAnamChatStreamRoutes(app, apiStack);
// Phase42: Fish Audio TTS (Anam内蔵TTS回避 — 自然な日本語音声)
registerFishTtsRoutes(app, apiStack);

// Internal: avatar-agent → TTS/Avatar使用量レポート（X-Internal-Request: 1 認証）
registerInternalUsageRoutes(app);

// Internal: avatar-agent → テナント別アバター設定取得（X-Internal-Request: 1 認証）
registerInternalAvatarConfigRoutes(app);

// Phase41: Avatar Customization Studio — Admin CRUD API
if (db) registerAvatarConfigRoutes(app, db);

// Phase41: Avatar Customization Studio — 画像生成・声マッチング・プロンプト生成API
if (db) registerAvatarGenerationRoutes(app, db);

// Phase64: fal.ai Flux Pro アバター画像生成API
registerFalGenerationRoutes(app);

// Phase64: Flux 2 Pro + Magnific AI プレミアムアバター生成API
registerPremiumGenerationRoutes(app);

// Security Level 4: Dynamic per-tenant widget JS delivery
registerWidgetRoutes(app, db);

// Phase55: 行動イベント受信 API (Widget → Server)
if (db) registerEventRoutes(app, apiStack, db);

// Phase56: プロアクティブエンゲージメント CRUD + Widget API
registerEngagementRoutes(app, apiStack, db);

// Phase58: コンバージョン最適化ループ
registerConversionRoutes(app, apiStack, db);
if (db) registerAbTestRoutes(app, db);

// Phase55: Widget features check (event_tracking フラグ取得)
app.get('/api/widget/features', ...apiStack, async (req: express.Request, res: express.Response) => {
  const tenantId: string = (req as any).tenantId ?? '';
  if (!db || !tenantId) {
    return res.json({ event_tracking: false });
  }
  try {
    const result = await db.query(
      'SELECT features FROM tenants WHERE id = $1 AND is_active = true',
      [tenantId],
    );
    const features = result.rows[0]?.features ?? {};
    return res.json({ event_tracking: !!features.event_tracking });
  } catch {
    return res.json({ event_tracking: false });
  }
});

async function startServer() {
  app.listen(port, () => {
    logger.info({ port, env: process.env.NODE_ENV }, "server listening");
  });

  // Phase23: AlertEngine — 60秒周期で KPI を評価し Slack アラートを送信
  alertEngine.start();
  logger.info("[startup] AlertEngine started");

  // Phase37 Step6: Stripe 日次使用量送信（24時間ごと）
  if (db && process.env.STRIPE_SECRET_KEY) {
    const STRIPE_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
    setInterval(() => {
      reportUsageToStripe(db, logger).catch((err) => {
        logger.error({ err }, "[billingScheduler] reportUsageToStripe failed");
      });
    }, STRIPE_REPORT_INTERVAL_MS);
    logger.info("[startup] Stripe usage reporter scheduled (24h interval)");
  }
}

startServer().catch((error) => {
  logger.error({ error }, "fatal error during server startup");
  process.exit(1);
});
