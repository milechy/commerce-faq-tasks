import "dotenv/config";
import "./config/env";

import { pool as db } from "./lib/db";
import { recordWidgetSeenOnce } from "./lib/onboardingWidgetSeen";
import { alertEngine } from "./lib/alerts/alertEngine";
import { billingHealthMonitor } from "./lib/billing/billingHealthCheck";
import { billingReconciliationMonitor } from "./lib/billing/billingReconciliation";
import { billingSyncReconciliationMonitor } from "./lib/billing/billingSyncReconciliation";
import { fetchSchemaHealth } from "./api/admin/analytics/schemaHealth";
import { SalesLogWriter, setGlobalSalesLogWriter } from "./agent/orchestrator/sales/salesLogWriter";
import { createSalesLogNotionSink } from "./integrations/notion/salesLogNotionSink";
import { judgeSweepRunner } from "./agent/judge/judgeSweepRunner";
import { autoTuningMonitor } from "./api/conversion/autoTuning";
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
import { initMetricsFlush } from "./lib/metrics/metricsFlush";
import { createChatHandler } from "./api/chat/route";
import { healthHandler } from "./lib/health";
import { businessHealthHandler } from "./lib/healthBusiness";
import { runDialogTurn } from "./agent/dialog/dialogAgent";
import { initAuthMiddleware } from "./agent/http/authMiddleware";
import { createAgentSearchHandler } from "./agent/http/agentSearchRoute";
import { fetchDefaultExcludedIds, mergeExcludedIds } from "./lib/defaultExcludedIds";
import { createCorsMiddleware } from "./lib/cors";
import { securityHeadersMiddleware } from "./lib/headers";
import { createRateLimitMiddleware } from "./lib/rate-limit";
import { requestIdMiddleware } from "./lib/request-id";
import { createSecurityPolicyMiddleware } from "./lib/security-policy";
import {
  createTenantContextMiddleware,
  getTenantByApiKeyHash,
  isOriginKnownToAnyTenant,
  seedTenantsFromEnv,
  seedTenantsFromDB,
} from "./lib/tenant-context";
import { registerKnowledgeAdminRoutes } from "./api/admin/knowledge/routes";
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
import { registerResourceRoutes } from "./api/admin/resources/routes";
import { registerBillingAdminRoutes } from "./lib/billing/billingApi";
import { createStripeWebhookHandler } from "./lib/billing/stripeWebhook";
import { initUsageTracker, trackUsage } from "./lib/billing/usageTracker";
import { buildChatUsageTracking } from "./lib/billing/chatUsage";
import { initFlowLogger } from "./lib/analytics/flowLogger";
import { resolveLearningConsentFromFeatures } from "./lib/hermesConsent";
import { stripeUsageReporter } from "./lib/billing/stripeSync";
import { pipelineQueue } from "./lib/book-pipeline/pipelineQueue";
import { supabaseAuthMiddleware } from "./admin/http/supabaseAuthMiddleware";
import { superAdminMiddleware } from "./api/admin/tenants/superAdminMiddleware";
import { langDetectMiddleware } from "./api/middleware/langDetect";
import { createOriginCheckMiddleware } from "./api/middleware/originCheck";
import { internalNetworkOnly } from "./api/middleware/internalNetworkOnly";
import { e2eWriteGuard } from "./api/middleware/e2eWriteGuard";
import { assertInternalSecretConfigured } from "./lib/startup/internalSecretGuard";
import { assertAuthSecretsConfigured } from "./lib/startup/authSecretsGuard";
import { registerWidgetRoutes } from "./api/widget/routes";
import { registerWpProvisionRoutes } from "./api/widget/wpProvisionRoutes";
import { registerWpSettingsRoutes } from "./api/widget/wpSettingsRoutes";
import { registerShopifyOAuthRoutes } from "./api/widget/shopifyOAuthRoutes";
import { registerShopifyWebhookRoutes } from "./api/widget/shopifyWebhookRoutes";
import { registerShopifySettingsRoutes } from "./api/widget/shopifySettingsRoutes";
import { registerAuthRoutes } from "./api/auth/routes";
import { registerLiveKitTokenRoutes } from "./api/avatar/livekitTokenRoutes";
import { registerAnamRoutes } from "./api/avatar/anamRoutes";
import { registerAnamChatStreamRoutes } from "./api/avatar/anamChatStreamRoutes";
import { registerFishTtsRoutes } from "./api/avatar/fishTtsRoutes";
import { registerFishAsrRoutes } from "./api/avatar/fishAsrRoutes";
import { registerAvatarGenerationRoutes } from "./api/admin/avatar/generationRoutes";
import { registerFalGenerationRoutes } from "./api/admin/avatar/falGenerationRoutes";
import { registerPremiumGenerationRoutes } from "./api/admin/avatar/premiumGenerationRoutes";
import { registerInternalUsageRoutes } from "./api/internal/usageRoutes";
import { registerInternalAvatarConfigRoutes } from "./api/internal/avatarConfigRoutes";
import { registerInternalAvatarTranscriptRoutes } from "./api/internal/avatarTranscriptRoutes";
import { registerGa4TenantRoutes } from "./api/admin/tenants/ga4Routes";
import { registerPostHogTenantRoutes } from "./api/admin/tenants/posthogRoutes";
import { flushPostHog } from "./lib/posthog/posthogClient";
import { registerAnalyticsSummaryRoutes } from "./api/admin/tenants/analyticsSummaryRoutes";
import { registerNotificationPreferencesRoutes } from "./api/admin/tenants/notificationPreferencesRoutes";
import { registerInternalGa4SyncRoutes } from "./api/internal/ga4SyncRoutes";
import { registerEvaluationRoutes } from "./api/admin/evaluations/routes";
import { registerVariantRoutes } from "./api/admin/variants/routes";
import { registerObjectionPatternRoutes } from "./api/admin/objection-patterns/routes";
import { registerAnalyticsRoutes } from "./api/admin/analytics/routes";
import { registerEventAnalyticsRoutes } from "./api/admin/analytics/eventAnalyticsRoutes";
import { registerEventRoutes } from "./api/events/eventRoutes";
import { registerEngagementRoutes } from "./api/engagement/engagementRoutes";
import { registerEscalationRoutes } from "./api/chat/escalationRoutes";
import { registerConversionRoutes } from "./api/conversion/conversionRoutes";
import { registerAbTestRoutes } from "./api/conversion/abTestRoutes";
import { registerAbExposureRoutes } from "./api/conversion/abExposureRoutes";
import { registerHermesMcpRoutes } from "./api/hermes-mcp/routes";
import { registerKnowledgeGapPhase46Routes } from "./api/admin/knowledge-gaps/routes";
import { registerNotificationRoutes } from "./api/admin/notifications/routes";
import { registerOptionRoutes } from "./api/admin/options/routes";
import { registerAdminAgentRoutes } from "./api/admin/agent/agentRoutes";
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
// Seed tenant registry: env vars first, then DB (env takes precedence)
// ---------------------------------------------------------------------------
// seedTenantsFromEnv() は同期・即時完了するためここでよいが、DB側の読み込みは
// startServer() 内で await し、app.listen() より前に完了させる(2026-09-04是正・
// GID 1218171750803663)。以前はここでfire-and-forget(.catchのみ)していたため、
// テナント登録が終わる前でもリクエストを受け付けられる構造になっており、
// 起動直後の一過性の欠落(seedTenantsFromDB側の二重読み取りで別途対処)と
// 組み合わさると、登録漏れテナントの認証が起動直後の窓の間だけ失敗し得た。
seedTenantsFromEnv();

// ---------------------------------------------------------------------------
// Global middleware (applied to ALL requests, order matters)
// ---------------------------------------------------------------------------
app.use(requestIdMiddleware);
app.use(securityHeadersMiddleware);

// Stripe Webhook（raw body 必須 — グローバル express.json より前に登録し、
// このルートだけ json パーサーの対象から外す。ここで先にマッチしなければ
// req.body が object に変換されて署名検証(constructEvent)が常に失敗する）
app.post(
  "/v1/billing/webhook",
  express.raw({ type: "application/json" }),
  createStripeWebhookHandler(db, logger)
);

// Shopify GDPR Webhook 3種 + app/uninstalled（raw body必須 — Stripe Webhookと
// 同一の理由・同一のパターン。ファイル内部で該当4ルートにのみ express.raw() を
// 適用しているため、この呼び出し自体は express.json() より前でなければならない）
registerShopifyWebhookRoutes(app, db);

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
  isKnownTenantOrigin: isOriginKnownToAnyTenant,
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
// pre-auth: keyed by nginx X-Real-IP — catches flood traffic before tenantId
// exists, so one client can no longer exhaust every tenant's shared bucket.
const ipRateLimiter = createRateLimitMiddleware({ logger, stage: "ip" });
const authMiddleware = initAuthMiddleware({
  resolveByApiKeyHash: getTenantByApiKeyHash,
});
const tenantContext = createTenantContextMiddleware({ logger });
// post-auth: keyed by tenantId once authMiddleware/tenantContext resolved it.
const tenantRateLimiter = createRateLimitMiddleware({ logger, stage: "tenant" });
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
        // TODO(security): script-src の 'unsafe-inline' を撤去したい。ただし public 配下は
        // widget.js の埋め込み(#1039で inline 消失→本番チャット全停止の前例あり)と LP/デモの
        // inline <script> に広く依存しており、一律撤去は破壊的。carnation-demo は本コミットで
        // クエリ由来値の innerHTML sink を除去済み(reflected XSS の能動的経路は閉塞)なので、
        // ここでの 'unsafe-inline' は現状「多層防御の一段」に留まる。恒久対応は inline を外部
        // ファイル化 or nonce/hash 化してパス単位で段階的に締める(別タスク)。
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com",
        "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
        "img-src 'self' data: https://cdn.leonardo.ai https://rpqrwifbrhlebbelyqog.supabase.co",
        "connect-src 'self' https://api.r2c.biz wss://*.livekit.cloud",
        "media-src 'self' https: blob:",
        "frame-ancestors 'self'",
      ].join("; ")
    );
    // LP の demo-frame.html は同一オリジン iframe で埋め込むため SAMEORIGIN に緩和
    // (グローバルの securityHeadersMiddleware が DENY を設定するため上書き必須)
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
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
// widget.min.js(SCRIPTS/build-widget.sh が生成していた静的な難読化ビルド)は撤去済み。
// 難読化は同一ロジックが /widget.js として平文で配信されているため元々無意味だった上、
// javascript-obfuscator の出力がビルドごとに変わり widget.js との一致を機械的に固定できず、
// #871 以降誰も再ビルドしないまま古いコードが本番に残り続けていた(2026-08-29発覚)。
// 外部に古い埋め込みが残っていた場合に404ではなく最新のwidget.jsへ導くためリダイレクトする。
// javascript-obfuscator 自体は widgetGenerator.ts の動的ルート(/widget/:tenantSlug.js、
// リクエスト毎にテナント設定を注入して難読化)が別途requireしており、これとは無関係。
// devDependencies から削除しないこと(削除するとwidgetGenerator.test.tsが壊れる)。
app.get("/widget.min.js", (_req, res) => res.redirect(301, "/widget.js"));

// CE status is public (side-effect free)
app.get("/ce/status", (_req, res) => {
  return res.json(ceStatus());
});

// Health check — public, no sensitive data returned
app.get("/health", healthHandler);

// Business KPI health check — UATa 事例 #6: scheduler_healthy 誤判断回避。
//
// ★セキュリティ★ このエンドポイントは アクティブ tenant_id 一覧・24h の会話/CV/RAG
// 件数・最終会話時刻という営業機微を返すため、素の /health（機微なし）と違い
// 公開してはならない（外部から無認証で開示できた実績あり）。/metrics と同じ内部
// 専用防御にそろえる:
//   - internalNetworkOnly: socket peer が loopback でなければ 403（ヘッダ spoof 不可）
//   - X-Internal-Request: 1 ヘッダ要求（nginx strip との二重防御）
app.get("/health/business", internalNetworkOnly, (req, res, next) => {
  if (req.headers[INTERNAL_REQUEST_HEADER] !== "1") {
    return res.status(403).json({ error: "forbidden" });
  }
  return next();
}, businessHealthHandler);

// Prometheus metrics — 内部ネットワーク専用
//   - internalNetworkOnly: socket peer が loopback でなければ 403（spoof不可）
//   - X-Internal-Request: 1 ヘッダ要求（後方互換 + nginx strip と合わせ二重防御）
app.get("/metrics", internalNetworkOnly, async (req, res) => {
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
  ipRateLimiter,         // 1. Rate limit (pre-auth, IP-keyed)
  authMiddleware,        // 2. Auth → tenantId
  tenantContext,         // 3. Load TenantConfig
  tenantRateLimiter,     // 3.5 Rate limit (post-auth, tenantId-keyed)
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
    const tenantId = (req as AuthedRequest).tenantId;
    const results = await hybridSearch(q, tenantId);
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
    const tenantId = (req as AuthedRequest).tenantId;
    const tSearch0 = Date.now();
    const results = await hybridSearch(q, tenantId);
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
        // Phase69-2 [外1] GID 1218086284362759: agentSearchRoute.ts の
        // AgentSearchSchema.excluded_ids と制約を完全に揃える（最大500件）。
        excluded_ids: z.array(z.string()).max(500).optional(),
      })
      // 根本対策: 未知キーは黙って strip せず 400 で明示的に拒否する
      // (excluded_ids が長らく無言で捨てられていた事故の再発防止)。
      .strict()
      .optional(),
  });

  const parsed = schemaIn.safeParse(req.body ?? {});
  if (!parsed.success) {
    // options 配下の検証エラー（excluded_ids の制約違反・未知キー混入を含む）は
    // docs/PHASE69_2_API_SPEC.md §2.3 の仕様どおり invalid_excluded_ids で返す。
    // それ以外（message 欠落など）は従来どおり invalid_request のまま。
    const touchesOptions = parsed.error.issues.some(
      (issue) => issue.path[0] === "options"
    );
    if (touchesOptions) {
      return res.status(400).json({
        error: "invalid_excluded_ids",
        details: parsed.error.flatten(),
      });
    }
    return res.status(400).json({
      error: "invalid_request",
      details: parsed.error.issues,
    });
  }

  try {
    const tenantId = (req as AuthedRequest).tenantId;

    // Phase69-2 [外1] GID 1218086284362759: agentSearchRoute.ts:93-95 と同じ形で
    // ルートハンドラ側だけでテナントの default_excluded_ids をリクエスト側の
    // excluded_ids とマージする。runDialogTurn（共有関数、/api/chat からも呼ばれる）
    // の内部に置くと /api/chat 経由の全トラフィックにも無条件のDB往復が発生して
    // しまうため、HTTP 直エンドポイントである /dialog/turn 側だけで行う。
    const dbDefaultExcludedIds = await fetchDefaultExcludedIds(tenantId ?? "");
    const mergedExcludedIds = mergeExcludedIds(
      parsed.data.options?.excluded_ids,
      dbDefaultExcludedIds
    );

    const turn = await runDialogTurn({
      ...parsed.data,
      tenantId,
      options: {
        ...parsed.data.options,
        excluded_ids: mergedExcludedIds,
      },
    });

    // 課金計上（収益監査ギャップ [P0]）: /dialog/turn は runDialogTurn で LLM 合成・
    // planner・OpenAI 埋め込みを実行するのに、これまで trackUsage を通っておらず
    // 完全に未計上だった。/api/chat と同じ抽出ロジック(buildChatUsageTracking)で
    // synthesis を chat モデル、planner/embedding を extraLlmUsages に内包して計上する。
    //   - tenantId は認証コンテキスト由来のみ（body/ヘッダ非信用。CLAUDE.md 禁止1）。
    //   - sessionId は runDialogTurn が確定した会話IDでグルーピングする（会話単位課金）。
    //   - fire-and-forget（trackUsage は setImmediate）なのでレスポンスをブロックしない。
    //   - 二重計上防止: /api/chat は自前で trackUsage するため、この計上は HTTP
    //     直エンドポイント /dialog/turn 経由のみ発火する（合成関数内には仕込まない）。
    if (tenantId) {
      trackUsage({
        tenantId,
        requestId: req.requestId,
        sessionId: turn.sessionId,
        featureUsed: "chat",
        ...buildChatUsageTracking(turn.meta),
      });
    }

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
    // このルートは requireRole("super_admin") 済みのため常に対象テナントを
    // 指定可能。ただし書き込み宛先は query から取る(body から禁止。
    // CLAUDE.md 禁止1。2026-08-25 是正: bookPdfRoutes.ts の
    // resolveUploadTenantId と同じ経路)。
    const target: string =
      (req.query.target as string | undefined) ||
      (req.query.tenant as string | undefined) ||
      tenantId;

    // "global" は super_admin のみ許可
    if (target === "global" && (req as any).user?.role !== "super_admin") {
      res.status(403).json({ error: "全店舗共通の知識データはSuper Adminのみ登録可能です" });
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

// E2E(Playwright)由来のリクエストから管理APIへの書き込みを拒否する。
// E2Eは専用環境を持たず本番を直接叩くため、CIからの事故で本番データが壊れるのを防ぐ。
// 管理系ルートの登録より前に置くこと(以降の register* は全てこのガードの内側になる)。
// 読み取り(GET/HEAD/OPTIONS)は通すので、画面到達性を見るE2Eの検証内容には影響しない。
app.use(["/v1/admin", "/admin"], e2eWriteGuard);

// Legacy FAQ admin routes (/admin/faqs)
registerFaqAdminRoutes(app);

// Phase29: ナレッジ管理API
registerKnowledgeAdminRoutes(app);

// Phase31: テナント管理API
if (db) registerTenantAdminRoutes(app, db);

// Phase A: GA4連携管理API (テナント別 connect/test/status/disconnect)
if (db) registerGa4TenantRoutes(app, db);

// Phase A Day 5: PostHog連携管理API
if (db) registerPostHogTenantRoutes(app, db);

// Phase A Day 6: Analytics Summary + Notification Preferences
if (db) registerAnalyticsSummaryRoutes(app, db);
if (db) registerNotificationPreferencesRoutes(app, db);

// Phase32: 課金管理API
if (db) initUsageTracker(db, logger);
// Phase72-C: フロー遷移ログ
if (db) initFlowLogger(db, logger);

// Phase72-C: State Machine 遷移ログ
if (db) initFlowLogger(db, logger);

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
// ナレッジギャップ検出・推薦・ナレッジ追加 API(Phase38+/Phase46)。
// 2026-08-25(P10): 2系統に分かれていたAPIをPhase46に一本化(旧
// registerKnowledgeGapRoutes は削除。admin-ui/copilot-preview も新パスへ移行済み)。
registerKnowledgeGapPhase46Routes(app);
// Phase43: admin_feedback チケット管理 API
registerAdminFeedbackManagementRoutes(app);
registerAdminAiAssistRoutes(app);

// Phase45: 評価API + KPI API
registerEvaluationRoutes(app);
// Phase46: Variant CRUD + Objection Patterns
registerVariantRoutes(app);
registerObjectionPatternRoutes(app);
registerAnalyticsRoutes(app);
// Phase55: 行動イベント分析 API
registerEventAnalyticsRoutes(app);
// Phase52h: In-App通知センター API
registerNotificationRoutes(app);
// Phase61: オプションサービス発注 API
registerOptionRoutes(app);

// Avatar: Widget → LiveKit Room トークン発行 API
registerLiveKitTokenRoutes(app, apiStack);

// Phase42: Avatar → Anam.ai セッショントークン発行 API
registerAnamRoutes(app, apiStack);
// Phase42: Avatar → Anam Client-Side Custom LLM (Groqストリーミング)
registerAnamChatStreamRoutes(app, apiStack);
// Phase42: Fish Audio TTS (Anam内蔵TTS回避 — 自然な日本語音声)
registerFishTtsRoutes(app, apiStack);
// Fish Audio ASR: Web Speech API 置換 — Transcribe-1 で信頼性向上
registerFishAsrRoutes(app, apiStack);

// Internal: avatar-agent → TTS/Avatar使用量レポート（X-Internal-Request: 1 認証）
registerInternalUsageRoutes(app);

// Internal: avatar-agent → テナント別アバター設定取得（X-Internal-Request: 1 認証）
registerInternalAvatarConfigRoutes(app);

// Phase75: Internal: avatar-agent(legacy Groqフォールバック経路) → 会話ログ永続化（X-Internal-Request: 1 認証）
registerInternalAvatarTranscriptRoutes(app);

// Phase A: GA4連携 内部API (Cloudflare Workers Cron用, HMAC認証)
if (db) registerInternalGa4SyncRoutes(app, db);

// Phase41: Avatar Customization Studio — Admin CRUD API
if (db) registerAvatarConfigRoutes(app, db);

// 資料オファー機能: テナント向け資料（PDF/外部URL）管理API
if (db) registerResourceRoutes(app, db);

// Phase41: Avatar Customization Studio — 画像生成・声マッチング・プロンプト生成API
if (db) registerAvatarGenerationRoutes(app, db);

// Phase B-Admin: AIエージェント管理チャット API
if (db) registerAdminAgentRoutes(app, db);

// Phase64: fal.ai Flux Pro アバター画像生成API
registerFalGenerationRoutes(app);

// Phase64: Flux 2 Pro + Magnific AI プレミアムアバター生成API
registerPremiumGenerationRoutes(app);

// Security Level 4: Dynamic per-tenant widget JS delivery
registerWidgetRoutes(app, db);

// WordPressプラグイン計画 WP-1/WP-2/WP-3: セルフサインアップ
// (docs/WORDPRESS_PLUGIN_REQUIREMENTS.md)。db が null の環境では
// registerWpProvisionRoutes 内の requireDb が 503 を返す(registerWidgetRoutes の
// DB未接続時フォールバックとは異なり、静的版へのリダイレクト先が無いため)。
registerWpProvisionRoutes(app, db);

// WordPressプラグイン計画 WP-13: 設定の読み書きAPI(D9/§13.2)。
// 真実は常にR2C側DBにあり、WPは遠隔操作であって権威ではない。
registerWpSettingsRoutes(app, db);

// Shopifyアプリ連携（docs/SHOPIFY_APP_REQUIREMENTS.md）。OAuthインストール・
// コールバックと、表示面選択・設定の読み書きAPI(D9/D18: 真実は常にR2C側DB)。
// Webhookは express.json() より前に registerShopifyWebhookRoutes で登録済み。
registerShopifyOAuthRoutes(app, db);
registerShopifySettingsRoutes(app, db);

// Phase55: 行動イベント受信 API (Widget → Server)
if (db) registerEventRoutes(app, apiStack, db);

// Phase56: プロアクティブエンゲージメント CRUD + Widget API
registerEngagementRoutes(app, apiStack, db);

// GID 1216275508391900: 有人チャットへのシームレスエスカレーション (Widget API)
registerEscalationRoutes(app, apiStack);

// Phase58: コンバージョン最適化ループ
registerConversionRoutes(app, apiStack, db);
if (db) registerAbTestRoutes(app, db);

// GID 1216978855735482: アバターA/Bテストの露出記録 (Widget → Server)
registerAbExposureRoutes(app, apiStack, db);

// Phase75: Hermes Agent(外部, 別VPS)向けMCPデータエンドポイント(Bearer認証、同意ゲート)
// R6: 提案(POST /v1/hermes-mcp/proposals)は tuning_rules(source='hermes')に着地する。
// 専用の承認API(旧 registerHermesProposalAdminRoutes)は作らず、Judge提案と同じ
// PUT /v1/admin/tuning/:id/approve|reject をそのまま使う(提案の受け皿を1つにする)。
registerHermesMcpRoutes(app);

// Phase55: Widget features check (event_tracking フラグ取得)
//
// P4: オンボーディング段階「設置検知」の記録を兼ねる。widget.js はページ読み込み
// ごと・apiKey保有時に必ずこのエンドポイントを叩く(public/widget.js:3185)。
// CDNキャッシュは widget.js 本体(静的ファイル)にのみかかり、この fetch() 自体は
// ブラウザから都度APIへ届くため設置検知の判定に使える
// (docs/ONBOARDING_FIRST_LOGIN.md §3.1③ 決定2)。
app.get('/api/widget/features', ...apiStack, async (req: express.Request, res: express.Response) => {
  const tenantId: string = (req as any).tenantId ?? '';
  if (!db || !tenantId) {
    return res.json({ event_tracking: false, data_shared_externally: false });
  }
  void recordWidgetSeenOnce(db, tenantId);
  try {
    const result = await db.query(
      'SELECT features FROM tenants WHERE id = $1 AND is_active = true',
      [tenantId],
    );
    const features = result.rows[0]?.features ?? {};
    return res.json({
      event_tracking: !!features.event_tracking,
      // 決定D1: 未設定は「出す」(既定ON)。event_tracking とは極性が逆
      // (機能追加時は既定OFFにする既存の慣習に対し、本件は「教師信号を
      // 増やす」ことが目的で、テナントが積極的にOFFを選ぶ場合だけ切る設計)。
      answer_feedback: features.answer_feedback !== false,
      // S5a(「D1・D5決定案」): 共有学習プールへの参加(share)がONのテナントは、
      // 会話ログが外部Hermes VPSへ送られる。ウィジェット側で消費者向け開示バナーを
      // 出す判定に使う。プラン(free_ad等)ではなく実際にデータが外に出る条件(share)
      // そのもので判定する(resolveLearningConsentFromFeaturesと優先順位を共有)。
      data_shared_externally: resolveLearningConsentFromFeatures(features, { tenantId }).share,
      // S6(共有学習プールの参加モデル・同意記録の分離是正): x-api-key から
      // サーバが解決した本物の tenantId。ウィジェット埋め込みの data-tenant 属性
      // (DOM由来・欠落/誤設定しうる)より信頼できるため、同意状態の永続化キーは
      // こちらを優先して使う(widget.js側)。
      tenant_id: tenantId,
    });
  } catch {
    // フラグ取得に失敗した場合も既定ONを維持する(D1: 出さない方が例外)。
    // data_shared_externally は fail-safeでfalse(resolveLearningConsentと同じ向き)。
    return res.json({ event_tracking: false, answer_feedback: true, data_shared_externally: false, tenant_id: tenantId });
  }
});

// Phase70-Q (GID 1215114679975245): langsmith CVE ignore の前提条件チェック.
// `pnpm.auditConfig.ignoreCves` で CVE-2026-45134 (langsmith) を除外しているが、
// これは「LangChain tracing が無効」という invariant に依存する.
// 本番で LANGCHAIN_TRACING / LANGSMITH_API_KEY 等が設定されると、ignore の前提が
// 崩れて vulnerable コードパスが起動する — fail-fast で起動阻止する.
// 詳細: docs/SECURITY_SCAN_ALLOWLIST.md#pnpm-auditconfig-ignorecves I-8
const LANGCHAIN_TRACING_ENV_VARS = [
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGSMITH_TRACING",
] as const;

function assertLangchainTracingDisabled(): void {
  const active = LANGCHAIN_TRACING_ENV_VARS.filter((k) => {
    const v = process.env[k];
    return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  });
  if (active.length === 0) return;
  const msg =
    `[startup] LangChain tracing env detected: ${active.join(", ")}. ` +
    "CVE-2026-45134 (langsmith) is currently ignored on the premise that tracing is disabled. " +
    "Either unset these env vars OR remove langsmith from package.json#pnpm.auditConfig.ignoreCves " +
    "before enabling tracing. Fail-closed at startup.";
  logger.error(msg);
  // eslint-disable-next-line no-console
  console.error(msg);
  process.exit(1);
}

async function startServer() {
  assertLangchainTracingDisabled();
  // Codex review #3/#4: 必須secretは boot 時に検証して fail-fast する。
  // 起動後に runtime 500 を吐き続ける partial outage を防ぐ。
  // production / staging / 不明 env では未設定なら exit(1)。
  // dev/test または ALLOW_MISSING_INTERNAL_HMAC_SECRET=true でのみ続行。
  assertInternalSecretConfigured({
    warn: (msg) => logger.warn(msg),
    fatal: (msg) => logger.fatal(msg),
  });
  // [P1 fail-closed] 認証/署名/暗号 secret（SUPABASE_JWT_SECRET / WIDGET_JWT_SECRET /
  // KNOWLEDGE_ENCRYPTION_KEY）を NODE_ENV に依らず起動時に検査。production/不明 env で
  // 欠落していれば exit(1)。dev/test は warn のみ。
  assertAuthSecretsConfigured({
    warn: (msg) => logger.warn(msg),
    fatal: (msg) => logger.fatal(msg),
  });

  // DB側のテナント登録(APIキー・プラン等)をリクエスト受付開始前に完了させる
  // (2026-09-04是正・GID 1218171750803663)。以前はモジュール直下でfire-and-forget
  // していたため、この完了を待たずにapp.listen()以降へ進んでいた。
  // ★.catch()を付けない★ seedTenantsFromDB自身が内部で全例外を握りつぶし
  // 決してrejectしない契約になっている(tenant-context.test.tsで固定済み)。
  // ここでの.catch()は到達不能なコードになるため付けない(2026-09-04レビュー是正)。
  if (db) {
    await seedTenantsFromDB(db, logger);
  }

  const server = app.listen(port, () => {
    logger.info({ port, env: process.env.NODE_ENV }, "server listening");
  });

  // Phase72-D: Prometheus メトリクス → metrics_snapshots DB 永続化（5分周期）
  const stopMetricsFlush = initMetricsFlush(db, logger);

  const onShutdown = (signal: string) => () => {
    logger.info({ signal }, "[shutdown] graceful shutdown initiated");
    stopMetricsFlush();
    server.close();
    flushPostHog()
      .catch((err) => logger.error({ err }, "[shutdown] flushPostHog failed"))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", onShutdown("SIGTERM"));
  process.on("SIGINT", onShutdown("SIGINT"));

  // Phase23: AlertEngine — 60秒周期で KPI を評価し Slack アラートを送信
  alertEngine.start();
  logger.info("[startup] AlertEngine started");

  // GID 1216970103691946 (PR-11): SalesLogWriter に Notion sink を接続する。
  // 未設定(NOTION_API_KEY / NOTION_DB_SALES_LOG_ID が無い)テナント運用も
  // 引き続き成立させるため、設定が揃っている場合のみ接続する(best-effort)。
  if (process.env.NOTION_API_KEY && process.env.NOTION_DB_SALES_LOG_ID) {
    try {
      setGlobalSalesLogWriter(new SalesLogWriter(createSalesLogNotionSink()));
      logger.info("[startup] SalesLogWriter (Notion) initialized");
    } catch (err) {
      logger.warn({ err }, "[startup] SalesLogWriter (Notion) init failed (non-blocking)");
    }
  }

  // 課金スキーマの欠落を起動時に1回検証する（2026-08-25 収益監査で判明:
  // 検出器(fetchSchemaHealth)は既に存在したが、呼び出し元が管理画面のAPIルート
  // 1箇所だけで、billed_quantity 列が本番未適用のまま何ヶ月も気づかれなかった）。
  // Slack(SLACK_WEBHOOK_URL)が未設定でも気づけるよう、ここでは logger.error に
  // 直接出す（billingHealthMonitor の定期チェックはSlack送信のみのため代替にならない）。
  // fail-fast にはしない — 起動できなくなる方が実害が大きい（記録が完全に止まる）。
  if (db) {
    fetchSchemaHealth(db).then((health) => {
      if (health.missing.length > 0) {
        logger.error(
          { missing: health.missing },
          "[startup] billing schema に欠落列があります。migration の適用状況を確認してください " +
          "(migration の自動実行は禁止。SCRIPTS/ci-billing-schema.sh の FILES 配列を参照)"
        );
      } else {
        logger.info("[startup] billing schema check: OK");
      }
    }).catch((err) => {
      logger.warn({ err }, "[startup] billing schema check failed (non-blocking)");
    });
  }

  // Phase37 Step6 → PR-3(2026-08-25収益監査): Stripe 日次使用量送信（24時間ごと）。
  // 旧実装はインラインの setInterval のみで起動直後の tick が無く、24時間連続稼働
  // して初めて1回目が走っていた(デプロイ頻度が高いR2Cでは実質一度も走らない状態に
  // なり得た)。stripeUsageReporter.start() は起動直後の実行・多重起動防止・
  // 前月分の併送を持つ(詳細: stripeSync.ts の StripeUsageReporter)。
  if (db && process.env.STRIPE_SECRET_KEY) {
    stripeUsageReporter.start(db, logger);
    logger.info("[startup] Stripe usage reporter started (initial tick + 24h interval)");
  } else if (db) {
    logger.warn("[startup] STRIPE_SECRET_KEY is not set — Stripe usage reporter NOT started (billing will not be sent to Stripe)");
  }

  // 課金パイプラインの不変条件監視（staging が無いため、テストではなく本番の
  // 定期チェックで守る。SLACK_WEBHOOK_URL 未設定でも sendSlackAlert が
  // サイレントスキップするため起動自体は妨げない）。
  if (db) {
    billingHealthMonitor.start(db, logger);
    logger.info("[startup] Billing health monitor started (1h interval)");
  }

  // 月次請求突合ジョブ。導入時は SCRIPTS/reconcile-billing.ts のCLIからしか
  // 呼ばれず、cron/systemd timer のいずれにも登録されておらず孤立していた
  // (厳格レビューで発覚)。billingHealthMonitor と同じく起動プロセスへ配線し、
  // デプロイに追従する形にする(cron登録は別途人間が行う運用に依存しない)。
  if (db) {
    billingReconciliationMonitor.start(db, logger);
    logger.info("[startup] Billing reconciliation monitor started (24h interval)");
  }

  // billing_sync 日次照合(P1-11、2026-08-26レビュー本筋対応)。プラン変更時
  // オンデマンドのsyncSubscriptionForTenantだけでは、webhook取りこぼし・
  // Stripeダッシュボードでの手動変更等でtenants.planとStripeの実態がズレても
  // 次のプラン変更まで誰も気づけない。billingReconciliationMonitorと同じく
  // 起動プロセスへ配線し、cron登録という人間の運用に依存しない形にする。
  if (db) {
    billingSyncReconciliationMonitor.start(db, logger);
    logger.info("[startup] Billing sync reconciliation monitor started (24h interval)");
  }

  // Phase70K: pipelineQueue self-heal — PM2再起動で stuck した job を自動復旧
  if (db) {
    const dbPool = db;
    pipelineQueue.selfHeal(dbPool).catch((err) => {
      logger.error({ err }, "[pipelineQueue] selfHeal failed");
    });

    const STUCK_JOB_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10分
    setInterval(() => {
      pipelineQueue.checkStuckJobs(dbPool).catch((err) => {
        logger.error({ err }, "[pipelineQueue] checkStuckJobs failed");
      });
    }, STUCK_JOB_CHECK_INTERVAL_MS);
    logger.info("[startup] pipelineQueue selfHeal + stuck-job monitor started");
  }

  // GID 1216970103691946 (PR-12): 離脱セッション自動評価スイープ。
  // chat_sessions 1,041件に対し conversation_evaluations は直近30日0件だった
  // (evaluateSessionの呼び元が本番チャットから発火しないため)。第2のJudgeは
  // 作らず既存のevaluateSessionをそのまま15分周期で呼ぶ。既定はr2c_defaultのみ
  // (JUDGE_SWEEP_TENANTSで段階開放、CLAUDE.md禁止35)。
  if (db) {
    const JUDGE_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15分
    judgeSweepRunner.start(JUDGE_SWEEP_INTERVAL_MS);
    logger.info("[startup] judgeSweepRunner started (15min interval)");
  }

  // A2A-0g: Auto-tuningフライホイール(autoTuning.ts の runAutoTuningCheck)が
  // export されておらず呼び出し元が無かったため、auto_tuning_suggestion 通知
  // (ab_winner の🏆バッジを含む)が一度も生成されていなかった。conversion/index.tsx
  // は既にポーリングしているため、通知を作る側をここに配線する(1h周期。
  // billingHealthMonitorと同じ周期)。
  if (db) {
    autoTuningMonitor.start();
    logger.info("[startup] autoTuningMonitor started (1h interval)");
  }
}

startServer().catch((error) => {
  logger.error({ error }, "fatal error during server startup");
  process.exit(1);
});
