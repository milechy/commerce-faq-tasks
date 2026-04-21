import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import type { AuthedReq } from "../../middleware/roleAuth";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { runGa4HealthCheck } from "../../../lib/ga4/ga4HealthCheck";
import { logger } from "../../../lib/logger";

const connectSchema = z.object({
  property_id: z
    .string()
    .min(1)
    .max(50)
    .regex(/^\d+$/, "GA4 Property IDは数字のみ"),
  contact_email: z.string().email().optional(),
});

export function registerGa4TenantRoutes(app: Express, db: Pool): void {
  function tenantAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization ?? "";
    if (process.env.NODE_ENV === "development") {
      if (authHeader.startsWith("Bearer ")) {
        try {
          (req as AuthedReq).supabaseUser =
            (jwt.decode(authHeader.slice(7).trim()) as import("../../middleware/roleAuth").SupabaseJwtUser) ?? undefined;
        } catch {
          // ignore
        }
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

  function canAccessTenant(
    req: Request,
    res: Response,
    tenantId: string,
    next: NextFunction,
  ): void {
    const su = (req as AuthedReq).supabaseUser;
    const role = su?.app_metadata?.role ?? su?.user_metadata?.role ?? "anonymous";
    const jwtTenantId = su?.app_metadata?.tenant_id as string | undefined;
    if (role === "super_admin" || jwtTenantId === tenantId) {
      next();
      return;
    }
    res.status(403).json({ error: "forbidden" });
  }

  // POST /v1/admin/tenants/:id/ga4/connect — GA4 Property ID登録
  app.post(
    "/v1/admin/tenants/:id/ga4/connect",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      const parsed = connectSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      }
      const { property_id, contact_email } = parsed.data;
      try {
        const updates = [
          "ga4_property_id = $1",
          "ga4_status = 'pending'",
          "ga4_invited_at = NOW()",
          "ga4_error_message = NULL",
          "updated_at = NOW()",
        ];
        const params: unknown[] = [property_id, req.params.id];
        if (contact_email) {
          updates.push(`tenant_contact_email = $${params.length + 1}`);
          params.splice(params.length - 1, 0, contact_email);
        }
        const result = await db.query(
          `UPDATE tenants SET ${updates.join(", ")}
           WHERE id = $${params.length}
           RETURNING id, ga4_property_id, ga4_status, ga4_invited_at`,
          params,
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: "not_found" });
        }

        await db.query(
          `INSERT INTO ga4_connection_logs
             (tenant_id, action, status, message, metadata, triggered_by)
           VALUES ($1, 'invite_sent', 'success', $2, $3, $4)`,
          [
            req.params.id,
            `GA4 property ${property_id} registered`,
            JSON.stringify({ property_id }),
            `user:${(req as AuthedReq).supabaseUser?.sub ?? "unknown"}`,
          ],
        );

        return res.json({ ok: true, tenant: result.rows[0] });
      } catch (err) {
        logger.warn({ err }, "[ga4Routes] connect failed");
        return res.status(500).json({ error: "connection failed" });
      }
    },
  );

  // POST /v1/admin/tenants/:id/ga4/test — 接続テスト実行
  app.post(
    "/v1/admin/tenants/:id/ga4/test",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      const tenantId = req.params.id;
      try {
        const row = await db.query(
          `SELECT ga4_property_id FROM tenants WHERE id = $1`,
          [tenantId],
        );
        if (row.rowCount === 0) {
          return res.status(404).json({ error: "not_found" });
        }
        const propertyId = row.rows[0].ga4_property_id as string | null;
        if (!propertyId) {
          return res.status(400).json({ error: "GA4 Property IDが未登録です" });
        }

        const result = await runGa4HealthCheck(tenantId, propertyId, db);
        return res.json({ ok: result.status === "connected", result });
      } catch (err) {
        logger.warn({ err }, "[ga4Routes] test failed");
        return res.status(500).json({ error: "test failed" });
      }
    },
  );

  // GET /v1/admin/tenants/:id/ga4/status — 現在のGA4状態
  app.get(
    "/v1/admin/tenants/:id/ga4/status",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      try {
        const result = await db.query(
          `SELECT ga4_property_id, ga4_status, ga4_invited_at, ga4_connected_at,
                  ga4_last_sync_at, ga4_error_message, tenant_contact_email
           FROM tenants WHERE id = $1`,
          [req.params.id],
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: "not_found" });
        }
        const history = await db.query(
          `SELECT test_type, success, error_message, tested_at
           FROM ga4_test_history WHERE tenant_id = $1
           ORDER BY tested_at DESC LIMIT 5`,
          [req.params.id],
        );
        return res.json({ ...result.rows[0], recent_tests: history.rows });
      } catch (err) {
        logger.warn({ err }, "[ga4Routes] status failed");
        return res.status(500).json({ error: "status fetch failed" });
      }
    },
  );

  // GET /v1/admin/ga4/service-account-info — サービスアカウントメール取得 (frontend表示用)
  app.get(
    "/v1/admin/ga4/service-account-info",
    tenantAuth,
    (_req: Request, res: Response) => {
      const credB64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
      if (!credB64) {
        return res.json({ configured: false, client_email: null });
      }
      try {
        const json = JSON.parse(Buffer.from(credB64, "base64").toString("utf-8")) as Record<string, unknown>;
        return res.json({ configured: true, client_email: json.client_email ?? null });
      } catch {
        return res.json({ configured: false, client_email: null });
      }
    },
  );

  // DELETE /v1/admin/tenants/:id/ga4/disconnect — GA4連携解除
  app.delete(
    "/v1/admin/tenants/:id/ga4/disconnect",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      try {
        const result = await db.query(
          `UPDATE tenants
           SET ga4_property_id = NULL, ga4_status = 'not_configured',
               ga4_connected_at = NULL, ga4_error_message = NULL, updated_at = NOW()
           WHERE id = $1
           RETURNING id`,
          [req.params.id],
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: "not_found" });
        }
        await db.query(
          `INSERT INTO ga4_connection_logs
             (tenant_id, action, status, triggered_by)
           VALUES ($1, 'disconnected', 'success', $2)`,
          [
            req.params.id,
            `user:${(req as AuthedReq).supabaseUser?.sub ?? "unknown"}`,
          ],
        );
        return res.json({ ok: true });
      } catch (err) {
        logger.warn({ err }, "[ga4Routes] disconnect failed");
        return res.status(500).json({ error: "disconnect failed" });
      }
    },
  );
}
