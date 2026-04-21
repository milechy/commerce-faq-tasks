import type { Express, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { internalHmacMiddleware } from "../../lib/crypto/hmacVerifier";
import { runGa4HealthCheck } from "../../lib/ga4/ga4HealthCheck";
import { fetchGa4Conversions } from "../../lib/ga4/ga4ConversionFetcher";
import { logger } from "../../lib/logger";

const healthCheckSchema = z.object({
  tenant_id: z.string().min(1),
});

const syncSchema = z.object({
  tenant_id: z.string().min(1),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("7daysAgo"),
  end_date: z.string().default("today"),
});

export function registerInternalGa4SyncRoutes(app: Express, db: Pool): void {
  // POST /internal/ga4/health-check-all — Workers Cron: 全連携テナント一括チェック
  app.post(
    "/internal/ga4/health-check-all",
    internalHmacMiddleware,
    async (_req: Request, res: Response) => {
      try {
        const rows = await db.query<{ id: string; ga4_property_id: string }>(
          `SELECT id, ga4_property_id FROM tenants
           WHERE is_active = true
             AND ga4_property_id IS NOT NULL
             AND ga4_status IN ('connected', 'error', 'timeout', 'permission_revoked', 'pending')`,
        );

        const results = await Promise.all(
          rows.rows.map(async (row) => {
            try {
              const result = await runGa4HealthCheck(row.id, row.ga4_property_id, db);
              return {
                tenant_id: row.id,
                status: result.status,
                error_message: result.errorMessage ?? null,
              };
            } catch (err) {
              return {
                tenant_id: row.id,
                status: "error" as const,
                error_message: err instanceof Error ? err.message.slice(0, 200) : String(err),
              };
            }
          }),
        );

        return res.json({ ok: true, results, checked_at: new Date().toISOString() });
      } catch (err) {
        logger.warn({ err }, "[internalGa4] health-check-all error");
        return res.status(500).json({ error: "internal error" });
      }
    },
  );

  // POST /internal/ga4/health-check — Cloudflare Workers Cron用
  app.post(
    "/internal/ga4/health-check",
    internalHmacMiddleware,
    async (req: Request, res: Response) => {
      const parsed = healthCheckSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      }
      const { tenant_id } = parsed.data;
      try {
        const row = await db.query(
          `SELECT ga4_property_id FROM tenants WHERE id = $1 AND is_active = true`,
          [tenant_id],
        );
        if (row.rowCount === 0) {
          return res.status(404).json({ error: "tenant_not_found" });
        }
        const propertyId = row.rows[0].ga4_property_id as string | null;
        if (!propertyId) {
          return res.json({ ok: false, reason: "ga4_not_configured" });
        }
        const result = await runGa4HealthCheck(tenant_id, propertyId, db);
        return res.json({ ok: result.status === "connected", result });
      } catch (err) {
        logger.warn({ err, tenant_id }, "[internalGa4] health-check error");
        return res.status(500).json({ error: "internal error" });
      }
    },
  );

  // POST /internal/ga4/sync — CV取得バッチ (Cloudflare Workers Cron用)
  app.post(
    "/internal/ga4/sync",
    internalHmacMiddleware,
    async (req: Request, res: Response) => {
      const parsed = syncSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      }
      const { tenant_id, start_date, end_date } = parsed.data;
      try {
        const row = await db.query(
          `SELECT ga4_property_id, ga4_status FROM tenants WHERE id = $1 AND is_active = true`,
          [tenant_id],
        );
        if (row.rowCount === 0) {
          return res.status(404).json({ error: "tenant_not_found" });
        }
        const { ga4_property_id: propertyId, ga4_status: status } = row.rows[0] as {
          ga4_property_id: string | null;
          ga4_status: string;
        };
        if (!propertyId || status !== "connected") {
          return res.json({ ok: false, reason: `ga4_status_${status}` });
        }
        const summary = await fetchGa4Conversions(tenant_id, propertyId, start_date, end_date, db);
        return res.json({ ok: !!summary, summary });
      } catch (err) {
        logger.warn({ err, tenant_id }, "[internalGa4] sync error");
        return res.status(500).json({ error: "internal error" });
      }
    },
  );
}
