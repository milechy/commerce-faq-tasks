import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import type { AuthedReq } from "../../middleware/roleAuth";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { logger } from "../../../lib/logger";

const upsertPreferencesSchema = z.object({
  notification_type: z.string().min(1).max(100),
  email_enabled: z.boolean(),
  in_app_enabled: z.boolean(),
  threshold: z.record(z.string(), z.unknown()).nullable().optional(),
});

export function registerNotificationPreferencesRoutes(app: Express, db: Pool): void {
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

  // GET /v1/admin/tenants/:id/notification-preferences
  app.get(
    "/v1/admin/tenants/:id/notification-preferences",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      const tenantId = req.params.id;
      try {
        const result = await db.query<{
          notification_type: string;
          email_enabled: boolean;
          in_app_enabled: boolean;
          threshold: Record<string, unknown> | null;
        }>(
          `SELECT notification_type, email_enabled, in_app_enabled, threshold
           FROM notification_preferences
           WHERE tenant_id = $1
           ORDER BY notification_type`,
          [tenantId],
        );
        return res.json({ preferences: result.rows });
      } catch (err) {
        logger.warn({ err, tenantId }, "[notificationPreferences] GET failed");
        return res.status(500).json({ error: "fetch failed" });
      }
    },
  );

  // PUT /v1/admin/tenants/:id/notification-preferences
  app.put(
    "/v1/admin/tenants/:id/notification-preferences",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      const tenantId = req.params.id;
      const parsed = upsertPreferencesSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid body", details: parsed.error.flatten() });
      }
      const { notification_type, email_enabled, in_app_enabled, threshold } = parsed.data;
      try {
        await db.query(
          `INSERT INTO notification_preferences
             (tenant_id, notification_type, email_enabled, in_app_enabled, threshold)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, notification_type)
           DO UPDATE SET
             email_enabled = EXCLUDED.email_enabled,
             in_app_enabled = EXCLUDED.in_app_enabled,
             threshold = EXCLUDED.threshold,
             updated_at = NOW()`,
          [tenantId, notification_type, email_enabled, in_app_enabled, threshold ?? null],
        );
        return res.json({ ok: true });
      } catch (err) {
        logger.warn({ err, tenantId }, "[notificationPreferences] PUT failed");
        return res.status(500).json({ error: "update failed" });
      }
    },
  );
}
