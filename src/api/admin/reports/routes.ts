// src/api/admin/reports/routes.ts

// Phase46: 週次レポート API（Stream A）

import type { Express, Request, Response } from "express";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { listReports, getReport, getUnreadCount } from "./reportsRepository";
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

export function registerReportRoutes(app: Express): void {
  app.use("/v1/admin/reports", supabaseAuthMiddleware);

  // -------------------------------------------------------------------------
  // GET /v1/admin/reports?tenantId=xxx
  // 週次レポート一覧（最新順）
  // -------------------------------------------------------------------------
  app.get("/v1/admin/reports", async (req: Request, res: Response) => {
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
    const { jwtTenantId, isSuperAdmin } = resolveAuth(req);

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
