// src/api/admin/objection-patterns/routes.ts

// Phase46: 反論パターン API（Stream A）

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import {
  listObjectionPatterns,
  getObjectionPattern,
  deleteObjectionPattern,
} from "./objectionPatternsRepository";
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function resolveAuth(req: Request): { jwtTenantId: string; isSuperAdmin: boolean } {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  return {
    jwtTenantId: su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "",
    isSuperAdmin: (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin",
  };
}

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerObjectionPatternRoutes(app: Express): void {
  app.use("/v1/admin/objection-patterns", supabaseAuthMiddleware);

  // -------------------------------------------------------------------------
  // GET /v1/admin/objection-patterns?tenantId=xxx
  // success_rate 降順
  // -------------------------------------------------------------------------
  app.get("/v1/admin/objection-patterns", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);
    const queryTenantId = req.query["tenantId"] as string | undefined;

    if (!isSuperAdmin && queryTenantId && queryTenantId !== jwtTenantId) {
      return res.status(403).json({ error: "他テナントのデータにアクセスできません" });
    }

    const tenantId = isSuperAdmin ? (queryTenantId || jwtTenantId) : jwtTenantId;

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId が必要です" });
    }

    try {
      const patterns = await listObjectionPatterns(tenantId);
      return res.json({ patterns });
    } catch (err) {
      logger.warn("[GET /v1/admin/objection-patterns]", err);
      return res.status(500).json({ error: "パターンの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/objection-patterns/:id
  // -------------------------------------------------------------------------
  app.get("/v1/admin/objection-patterns/:id", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "idが不正です" });
    }

    const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;

    try {
      const pattern = await getObjectionPattern(id, tenantId);
      if (!pattern) {
        return res.status(404).json({ error: "パターンが見つかりません" });
      }
      return res.json({ pattern });
    } catch (err) {
      logger.warn("[GET /v1/admin/objection-patterns/:id]", err);
      return res.status(500).json({ error: "パターンの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/admin/objection-patterns/:id
  // -------------------------------------------------------------------------
  app.delete("/v1/admin/objection-patterns/:id", async (req: Request, res: Response) => {
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "idが不正です" });
    }

    const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;

    try {
      const deleted = await deleteObjectionPattern(id, tenantId);
      if (!deleted) {
        return res.status(404).json({ error: "パターンが見つかりません" });
      }
      return res.json({ ok: true });
    } catch (err) {
      logger.warn("[DELETE /v1/admin/objection-patterns/:id]", err);
      return res.status(500).json({ error: "パターンの削除に失敗しました" });
    }
  });
}
