// src/api/admin/reports/routes.ts

// Phase46: 週次レポート API（Stream A）

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { listReports, getReport, getUnreadCount } from "./reportsRepository";
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist (Phase69-1.5 PR-C4 v2)
// ---------------------------------------------------------------------------

const ALLOWED_REPORT_ROLES = ['super_admin', 'client_admin'] as const;
type AllowedReportRole = typeof ALLOWED_REPORT_ROLES[number];
function isAllowedReportRole(role: unknown): role is AllowedReportRole {
  return typeof role === 'string' &&
         (ALLOWED_REPORT_ROLES as readonly string[]).includes(role);
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

function denyReportRole(req: Request, res: Response, su: Record<string, any> | undefined, role: unknown) {
  logger.warn({
    event: 'reports_access_denied',
    reason: 'invalid_role',
    errorCode: 'AUTHZ_ROLE_DENIED',
    requested_path: req.path,
    actor_email: su?.['email'] ? String(su['email']).slice(0, 3) + '***' : 'unknown',
    actor_role: role,
    required_roles: ALLOWED_REPORT_ROLES,
    hasAppMetadataRole: !!su?.['app_metadata']?.role,
    hasUserMetadataRole: !!su?.['user_metadata']?.role,
  }, 'reports access denied: invalid actor role');
  return res.status(403).json({ error: 'この操作を実行する権限がありません', code: 'AUTHZ_ROLE_DENIED' });
}

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerReportRoutes(app: Express): void {
  app.use("/v1/admin/reports", supabaseAuthMiddleware);

  // -------------------------------------------------------------------------
  // GET /v1/admin/reports?tenantId=xxx
  // 週次レポート一覧（最新順）
  // -------------------------------------------------------------------------
  app.get("/v1/admin/reports", async (req: Request, res: Response) => {
    const { su, role, jwtTenantId, isSuperAdmin } = resolveAuth(req);
    if (!isAllowedReportRole(role)) {
      return denyReportRole(req, res, su, role);
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
      const reports = await listReports(tenantId);
      return res.json({ reports });
    } catch (err) {
      logger.warn("[GET /v1/admin/reports]", err);
      return res.status(500).json({ error: "レポートの取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/reports/unread-count?tenantId=xxx
  // 未読レポート数（通知バッジ用）
  // NOTE: 静的パスなので /:id より先に登録
  // -------------------------------------------------------------------------
  app.get("/v1/admin/reports/unread-count", async (req: Request, res: Response) => {
    const { su, role, jwtTenantId, isSuperAdmin } = resolveAuth(req);
    if (!isAllowedReportRole(role)) {
      return denyReportRole(req, res, su, role);
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
      const count = await getUnreadCount(tenantId);
      return res.json({ count });
    } catch (err) {
      logger.warn("[GET /v1/admin/reports/unread-count]", err);
      return res.status(500).json({ error: "未読数の取得に失敗しました" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/reports/:id
  // -------------------------------------------------------------------------
  app.get("/v1/admin/reports/:id", async (req: Request, res: Response) => {
    const { su, role, jwtTenantId, isSuperAdmin } = resolveAuth(req);
    if (!isAllowedReportRole(role)) {
      return denyReportRole(req, res, su, role);
    }

    const id = Number(req.params["id"]);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "idが不正です" });
    }

    const tenantId = isSuperAdmin ? undefined : jwtTenantId || undefined;

    try {
      const report = await getReport(id, tenantId);
      if (!report) {
        return res.status(404).json({ error: "レポートが見つかりません" });
      }
      return res.json({ report });
    } catch (err) {
      logger.warn("[GET /v1/admin/reports/:id]", err);
      return res.status(500).json({ error: "レポートの取得に失敗しました" });
    }
  });
}
