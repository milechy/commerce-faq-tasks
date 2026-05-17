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
// ALLOWED_ROLES whitelist (Phase69-1.5 PR-C4 v2)
// ---------------------------------------------------------------------------

const ALLOWED_OBJECTION_PATTERN_ROLES = ['super_admin', 'client_admin'] as const;
type AllowedObjectionPatternRole = typeof ALLOWED_OBJECTION_PATTERN_ROLES[number];
function isAllowedObjectionPatternRole(role: unknown): role is AllowedObjectionPatternRole {
  return typeof role === 'string' &&
         (ALLOWED_OBJECTION_PATTERN_ROLES as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function resolveAuth(req: Request): { su: Record<string, any> | undefined; role: unknown; jwtTenantId: string; isSuperAdmin: boolean } {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const role: unknown = su?.app_metadata?.role;
  return {
    su,
    role,
    jwtTenantId: su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "",
    isSuperAdmin: role === "super_admin",
  };
}

function denyObjectionPatternRole(req: Request, res: Response, su: Record<string, any> | undefined, role: unknown) {
  logger.warn({
    event: 'objection_patterns_access_denied',
    reason: 'invalid_role',
    errorCode: 'AUTHZ_ROLE_DENIED',
    requested_path: req.path,
    actor_email: su?.['email'] ? String(su['email']).slice(0, 3) + '***' : 'unknown',
    actor_role: role,
    required_roles: ALLOWED_OBJECTION_PATTERN_ROLES,
    hasAppMetadataRole: !!su?.['app_metadata']?.role,
    hasUserMetadataRole: !!su?.['user_metadata']?.role,
  }, 'objection-patterns access denied: invalid actor role');
  return res.status(403).json({ error: 'この操作を実行する権限がありません', code: 'AUTHZ_ROLE_DENIED' });
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
    const { su, role, jwtTenantId, isSuperAdmin } = resolveAuth(req);
    if (!isAllowedObjectionPatternRole(role)) {
      return denyObjectionPatternRole(req, res, su, role);
    }
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
    const { su, role, jwtTenantId, isSuperAdmin } = resolveAuth(req);
    if (!isAllowedObjectionPatternRole(role)) {
      return denyObjectionPatternRole(req, res, su, role);
    }

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
    const { su, role, jwtTenantId, isSuperAdmin } = resolveAuth(req);
    if (!isAllowedObjectionPatternRole(role)) {
      return denyObjectionPatternRole(req, res, su, role);
    }

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
