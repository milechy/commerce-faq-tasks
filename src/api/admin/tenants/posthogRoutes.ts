import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import type { AuthedReq } from "../../middleware/roleAuth";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { encryptText, decryptText, isEncrypted } from "../../../lib/crypto/textEncrypt";
import { logger } from "../../../lib/logger";

const connectSchema = z.object({
  project_api_key: z.string().min(1).max(200),
});

export function registerPostHogTenantRoutes(app: Express, db: Pool): void {
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

  // POST /v1/admin/tenants/:id/posthog/connect — PostHog Project API Key登録 (暗号化)
  app.post(
    "/v1/admin/tenants/:id/posthog/connect",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      const parsed = connectSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      }
      try {
        const encrypted = encryptText(parsed.data.project_api_key);
        const result = await db.query(
          `UPDATE tenants
           SET posthog_project_api_key_encrypted = $1, updated_at = NOW()
           WHERE id = $2
           RETURNING id`,
          [encrypted, req.params.id],
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: "not_found" });
        }
        return res.json({ ok: true });
      } catch (err) {
        logger.warn({ err }, "[posthogRoutes] connect failed");
        return res.status(500).json({ error: "save failed" });
      }
    },
  );

  // GET /v1/admin/tenants/:id/posthog/status — PostHog設定状態
  app.get(
    "/v1/admin/tenants/:id/posthog/status",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      try {
        const result = await db.query<{ posthog_project_api_key_encrypted: string | null }>(
          `SELECT posthog_project_api_key_encrypted FROM tenants WHERE id = $1`,
          [req.params.id],
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: "not_found" });
        }
        const encrypted = result.rows[0].posthog_project_api_key_encrypted;
        const configured = !!encrypted;
        const keyHint = configured && encrypted
          ? maskApiKey(decryptKey(encrypted))
          : null;
        return res.json({ configured, key_hint: keyHint });
      } catch (err) {
        logger.warn({ err }, "[posthogRoutes] status failed");
        return res.status(500).json({ error: "status fetch failed" });
      }
    },
  );

  // POST /v1/admin/tenants/:id/posthog/verify — 接続テスト
  app.post(
    "/v1/admin/tenants/:id/posthog/verify",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      try {
        const result = await db.query<{ posthog_project_api_key_encrypted: string | null }>(
          `SELECT posthog_project_api_key_encrypted FROM tenants WHERE id = $1`,
          [req.params.id],
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: "not_found" });
        }
        const encrypted = result.rows[0].posthog_project_api_key_encrypted;
        if (!encrypted) {
          return res.status(400).json({ error: "posthog_not_configured" });
        }
        const apiKey = decryptKey(encrypted);
        const apiHost = process.env.POSTHOG_API_HOST ?? "https://eu.i.posthog.com";

        const verifyRes = await fetch(`${apiHost}/decide?v=3`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ api_key: apiKey, distinct_id: "test-verify" }),
          signal: AbortSignal.timeout(10_000),
        });

        if (verifyRes.ok || verifyRes.status === 400) {
          return res.json({ ok: true, status: "connected" });
        }
        return res.json({ ok: false, status: "error", http_status: verifyRes.status });
      } catch (err) {
        logger.warn({ err }, "[posthogRoutes] verify failed");
        return res.status(500).json({ error: "verify failed" });
      }
    },
  );

  // DELETE /v1/admin/tenants/:id/posthog/disconnect — PostHog連携解除
  app.delete(
    "/v1/admin/tenants/:id/posthog/disconnect",
    tenantAuth,
    (req: Request, res: Response, next: NextFunction) =>
      canAccessTenant(req, res, req.params.id, next),
    async (req: Request, res: Response) => {
      try {
        const result = await db.query(
          `UPDATE tenants
           SET posthog_project_api_key_encrypted = NULL, updated_at = NOW()
           WHERE id = $1
           RETURNING id`,
          [req.params.id],
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: "not_found" });
        }
        return res.json({ ok: true });
      } catch (err) {
        logger.warn({ err }, "[posthogRoutes] disconnect failed");
        return res.status(500).json({ error: "disconnect failed" });
      }
    },
  );
}

function decryptKey(encrypted: string): string {
  try {
    return isEncrypted(encrypted) ? decryptText(encrypted) : encrypted;
  } catch {
    return encrypted;
  }
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}
