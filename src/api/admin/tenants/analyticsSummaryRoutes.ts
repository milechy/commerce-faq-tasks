import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import type { AuthedReq } from "../../middleware/roleAuth";
import jwt from "jsonwebtoken";
import { getMonthlyLLMUsageFromPostHog } from "../../../lib/billing/posthogUsageTracker";
import { logger } from "../../../lib/logger";

const PERIOD_DAYS: Record<string, number> = {
  last_7d: 7,
  last_30d: 30,
  last_90d: 90,
};

export function registerAnalyticsSummaryRoutes(app: Express, db: Pool): void {
  function tenantAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization ?? "";
    if (process.env.NODE_ENV === "development") {
      if (authHeader.startsWith("Bearer ")) {
        try {
          (req as AuthedReq).supabaseUser =
            (jwt.decode(authHeader.slice(7).trim()) as import("../../middleware/roleAuth").SupabaseJwtUser) ?? undefined;
        } catch { /* ignore */ }
      }
      next();
      return;
    }
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) { next(); return; }
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Bearer token" });
      return;
    }
    try {
      (req as AuthedReq).supabaseUser = jwt.verify(
        authHeader.slice(7).trim(),
        secret,
      ) as import("../../middleware/roleAuth").SupabaseJwtUser;
      next();
    } catch {
      res.status(401).json({ error: "Invalid token" });
    }
  }

  function canAccessTenant(req: Request, res: Response, tenantId: string, next: NextFunction): void {
    const su = (req as AuthedReq).supabaseUser;
    const role = su?.app_metadata?.role ?? su?.user_metadata?.role ?? "anonymous";
    const jwtTenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (role === "super_admin" || jwtTenantId === tenantId) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  }

  // GET /v1/admin/tenants/:id/analytics-summary
  app.get(
    "/v1/admin/tenants/:id/analytics-summary",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      const tenantId = req.params.id;
      const periodKey = (req.query.period as string) ?? "last_30d";
      const days = PERIOD_DAYS[periodKey] ?? 30;
      const interval = `${days} days`;

      try {
        const [
          conversationsRow,
          cvMacroRow,
          cvMicroRow,
          cvRankRow,
          alertRow,
        ] = await Promise.all([
          db.query<{ total: string; avg_per_day: string }>(
            `SELECT
               COUNT(*)::text AS total,
               ROUND(COUNT(*) / GREATEST($2::float, 1), 2)::text AS avg_per_day
             FROM chat_sessions
             WHERE tenant_id = $1
               AND created_at >= NOW() - ($3::text)::interval`,
            [tenantId, days, interval],
          ),
          db.query<{ source: string; cnt: string }>(
            `SELECT source, COUNT(*)::text AS cnt
             FROM conversion_attributions
             WHERE tenant_id = $1
               AND event_type = 'macro'
               AND created_at >= NOW() - ($2::text)::interval
             GROUP BY source`,
            [tenantId, interval],
          ),
          db.query<{ source: string; cnt: string }>(
            `SELECT source, COUNT(*)::text AS cnt
             FROM conversion_attributions
             WHERE tenant_id = $1
               AND event_type = 'micro'
               AND created_at >= NOW() - ($2::text)::interval
             GROUP BY source`,
            [tenantId, interval],
          ),
          db.query<{ rank: string; cnt: string }>(
            `SELECT rank, COUNT(*)::text AS cnt
             FROM conversion_attributions
             WHERE tenant_id = $1
               AND created_at >= NOW() - ($2::text)::interval
             GROUP BY rank`,
            [tenantId, interval],
          ),
          db.query<{ mismatch: string; ranked_d: string }>(
            `SELECT
               COUNT(CASE WHEN fired_count > 1 THEN 1 END)::text AS mismatch,
               COUNT(CASE WHEN rank = 'D' THEN 1 END)::text AS ranked_d
             FROM conversion_attributions
             WHERE tenant_id = $1
               AND created_at >= NOW() - ($2::text)::interval`,
            [tenantId, interval],
          ),
        ]);

        const toNum = (s: string | undefined) => parseInt(s ?? "0", 10);

        const macroBySource = Object.fromEntries(
          cvMacroRow.rows.map((r) => [r.source, toNum(r.cnt)]),
        );
        const microBySource = Object.fromEntries(
          cvMicroRow.rows.map((r) => [r.source, toNum(r.cnt)]),
        );
        const rankDist = Object.fromEntries(
          cvRankRow.rows.map((r) => [r.rank, toNum(r.cnt)]),
        );

        // PostHog LLM usage (optional, non-blocking)
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const llmUsage = await getMonthlyLLMUsageFromPostHog(tenantId, month).catch(() => null);

        const alertData = alertRow.rows[0];

        return res.json({
          period: periodKey,
          conversations: {
            total: toNum(conversationsRow.rows[0]?.total),
            avg_per_day: parseFloat(conversationsRow.rows[0]?.avg_per_day ?? "0"),
          },
          cv: {
            macro: {
              r2c_db: macroBySource.r2c_db ?? 0,
              ga4: macroBySource.ga4 ?? 0,
              posthog: macroBySource.posthog ?? 0,
              ranked_a: rankDist.A ?? 0,
              ranked_d: rankDist.D ?? 0,
            },
            micro: {
              r2c_db: microBySource.r2c_db ?? 0,
              ga4: microBySource.ga4 ?? 0,
              posthog: microBySource.posthog ?? 0,
            },
          },
          llm_usage: llmUsage
            ? {
                tokens: llmUsage.totalInputTokens + llmUsage.totalOutputTokens,
                cost_jpy: Math.round(llmUsage.estimatedCostUsd * 150),
                generations: llmUsage.totalGenerations,
              }
            : null,
          alerts: {
            source_mismatch_count: toNum(alertData?.mismatch),
            ranked_d_count: toNum(alertData?.ranked_d),
          },
        });
      } catch (err) {
        logger.warn({ err, tenantId }, "[analyticsSummary] failed");
        return res.status(500).json({ error: "analytics fetch failed" });
      }
    },
  );
}
