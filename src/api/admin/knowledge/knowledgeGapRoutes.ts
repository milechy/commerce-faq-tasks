// src/api/admin/knowledge/knowledgeGapRoutes.ts

// Phase38+: ナレッジギャップ管理 API

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import {
  getGaps,
  getGapCount,
  updateGapStatus,
} from "./knowledgeGapRepository";
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist (Phase69-1.5 PR-C4 v2)
// ---------------------------------------------------------------------------

const ALLOWED_KG_LEGACY_ROLES = ['super_admin', 'client_admin'] as const;
type AllowedKgLegacyRole = typeof ALLOWED_KG_LEGACY_ROLES[number];
function isAllowedKgLegacyRole(role: unknown): role is AllowedKgLegacyRole {
  return typeof role === 'string' &&
         (ALLOWED_KG_LEGACY_ROLES as readonly string[]).includes(role);
}

function resolveJwtTenantId(req: Request): { su: Record<string, any> | undefined; role: unknown; jwtTenantId: string; isSuperAdmin: boolean } {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const role: unknown = su?.app_metadata?.role;
  const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
  const isSuperAdmin: boolean = role === "super_admin";
  return { su, role, jwtTenantId, isSuperAdmin };
}

function denyKgLegacyRole(req: Request, res: Response, su: Record<string, any> | undefined, role: unknown) {
  logger.warn({
    event: 'knowledge_gaps_legacy_access_denied',
    reason: 'invalid_role',
    errorCode: 'AUTHZ_ROLE_DENIED',
    requested_path: req.path,
    actor_email: su?.['email'] ? String(su['email']).slice(0, 3) + '***' : 'unknown',
    actor_role: role,
    required_roles: ALLOWED_KG_LEGACY_ROLES,
    hasAppMetadataRole: !!su?.['app_metadata']?.role,
    hasUserMetadataRole: !!su?.['user_metadata']?.role,
  }, 'knowledge/gaps access denied: invalid actor role');
  return res.status(403).json({ error: 'この操作を実行する権限がありません', code: 'AUTHZ_ROLE_DENIED' });
}

const updateStatusSchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
  resolved_faq_id: z.number().int().positive().nullable().optional(),
});

export function registerKnowledgeGapRoutes(app: Express): void {
  app.use("/v1/admin/knowledge/gaps", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // GET /v1/admin/knowledge/gaps/count  (バッジ用: 未解決件数)
  // NOTE: この route は /:id より先に登録する必要がある
  // -----------------------------------------------------------------------
  app.get("/v1/admin/knowledge/gaps/count", async (req: Request, res: Response) => {
    const { su, role, jwtTenantId, isSuperAdmin } = resolveJwtTenantId(req);
    if (!isAllowedKgLegacyRole(role)) {
      return denyKgLegacyRole(req, res, su, role);
    }
    const tenantFilter = isSuperAdmin
      ? ((req.query["tenant"] as string | undefined) || undefined)
      : jwtTenantId;

    if (!isSuperAdmin && !tenantFilter) {
      return res.status(400).json({ error: "tenant が解決できません" });
    }

    try {
      const count = await getGapCount(tenantFilter);
      return res.json({ count });
    } catch (err) {
      logger.warn("[GET /knowledge/gaps/count]", err);
      return res.status(500).json({ error: "件数の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // GET /v1/admin/knowledge/gaps  (一覧)
  // -----------------------------------------------------------------------
  app.get("/v1/admin/knowledge/gaps", async (req: Request, res: Response) => {
    const { su, role, jwtTenantId, isSuperAdmin } = resolveJwtTenantId(req);
    if (!isAllowedKgLegacyRole(role)) {
      return denyKgLegacyRole(req, res, su, role);
    }
    const tenantFilter = isSuperAdmin
      ? ((req.query["tenant"] as string | undefined) || undefined)
      : jwtTenantId;

    if (!isSuperAdmin && !tenantFilter) {
      return res.status(400).json({ error: "tenant が解決できません" });
    }

    const statusParam = (req.query["status"] as string | undefined) ?? "open";
    const status =
      ["open", "resolved", "dismissed"].includes(statusParam)
        ? (statusParam as "open" | "resolved" | "dismissed")
        : "open";

    const limit = Math.max(1, Math.min(parseInt((req.query["limit"] as string) ?? "50", 10) || 50, 200));
    const offset = Math.max(0, parseInt((req.query["offset"] as string) ?? "0", 10) || 0);

    try {
      const result = await getGaps({ tenantId: tenantFilter, status, limit, offset });
      return res.json({ gaps: result.gaps, total: result.total, limit, offset });
    } catch (err) {
      logger.warn("[GET /knowledge/gaps]", err);
      return res.status(500).json({ error: "ギャップ一覧の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/knowledge/gaps/:id  (ステータス更新)
  // -----------------------------------------------------------------------
  app.patch("/v1/admin/knowledge/gaps/:id", async (req: Request, res: Response) => {
    const id = parseInt(req.params["id"] ?? "", 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "id が不正です" });
    }

    const { su, role, jwtTenantId, isSuperAdmin } = resolveJwtTenantId(req);
    if (!isAllowedKgLegacyRole(role)) {
      return denyKgLegacyRole(req, res, su, role);
    }
    const tenantId = isSuperAdmin ? undefined : jwtTenantId;

    if (!isSuperAdmin && !tenantId) {
      return res.status(400).json({ error: "tenant が解決できません" });
    }

    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "入力が不正です", issues: parsed.error.issues });
    }

    try {
      const ok = await updateGapStatus(
        id,
        parsed.data.status,
        tenantId,
        parsed.data.resolved_faq_id ?? null,
      );
      if (!ok) {
        return res.status(404).json({ error: "ギャップが見つかりません" });
      }
      return res.json({ ok: true });
    } catch (err) {
      logger.warn("[PATCH /knowledge/gaps/:id]", err);
      return res.status(500).json({ error: "更新に失敗しました" });
    }
  });
}
