// src/api/auth/routes.ts

// Phase34: 認証情報API
import type { Express, Request, Response } from "express";
// @ts-ignore
import { Pool } from "pg";
import { supabaseAuthMiddleware } from "../../admin/http/supabaseAuthMiddleware";
import { roleAuthMiddleware, type AuthenticatedUser } from "../middleware/roleAuth";
import { logger } from '../../lib/logger';

export function registerAuthRoutes(app: Express, db: Pool | null): void {
  // GET /v1/auth/me — ログイン中ユーザー情報を返す
  app.get(
    "/v1/auth/me",
    supabaseAuthMiddleware,
    roleAuthMiddleware,
    async (req: Request, res: Response) => {
      const user = (req as any).user as AuthenticatedUser | undefined;

      if (!user || user.role === "anonymous") {
        return res.status(401).json({ error: "unauthorized", message: "認証が必要です" });
      }

      let tenantName: string | null = null;
      if (user.tenantId && db) {
        try {
          const result = await db.query(
            "SELECT name FROM tenants WHERE id = $1",
            [user.tenantId]
          );
          tenantName = result.rows[0]?.name ?? null;
        } catch (err) {
          logger.warn("[GET /v1/auth/me] tenant lookup failed", err);
        }
      }

      return res.json({
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        tenantName,
      });
    }
  );
}
