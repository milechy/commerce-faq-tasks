// src/api/admin/chatTest/routes.ts
import type { Express, NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { logger } from '../../../lib/logger';

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist (Phase69-1.5 PR-C4 v2)
// ---------------------------------------------------------------------------

const ALLOWED_CHAT_TEST_ROLES = ['super_admin', 'client_admin'] as const;
type AllowedChatTestRole = typeof ALLOWED_CHAT_TEST_ROLES[number];
function isAllowedChatTestRole(role: unknown): role is AllowedChatTestRole {
  return typeof role === 'string' &&
         (ALLOWED_CHAT_TEST_ROLES as readonly string[]).includes(role);
}


export function registerChatTestRoutes(app: Express): void {
  // ── インライン認証スタック (knowledge/routes.ts と同パターン) ──────────────
  function chatTestAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization ?? "";

    if (process.env.NODE_ENV === "development") {
      if (authHeader.startsWith("Bearer ")) {
        try {
          (req as any).supabaseUser = jwt.decode(authHeader.slice(7).trim());
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
    const token = authHeader.slice(7).trim();
    try {
      (req as any).supabaseUser = jwt.verify(token, secret);
      next();
    } catch (err) {
      logger.warn("[chatTestAuth] invalid token", err);
      res.status(401).json({ error: "Invalid token" });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // GET /v1/admin/chat-test/token?tenantId=xxx
  app.get("/v1/admin/chat-test/token", chatTestAuth, async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const role: unknown = su?.app_metadata?.role;

    if (!isAllowedChatTestRole(role)) {
      logger.warn({
        event: 'chat_test_access_denied',
        reason: 'invalid_role',
        errorCode: 'AUTHZ_ROLE_DENIED',
        requested_path: req.path,
        actor_email: su?.['email'] ? String(su['email']).slice(0, 3) + '***' : 'unknown',
        actor_role: role,
        required_roles: ALLOWED_CHAT_TEST_ROLES,
        hasAppMetadataRole: !!su?.['app_metadata']?.role,
        hasUserMetadataRole: !!su?.['user_metadata']?.role,
      }, 'chat-test access denied: invalid actor role');
      return res.status(403).json({ error: "forbidden", message: "管理者ログインが必要です", code: 'AUTHZ_ROLE_DENIED' });
    }

    // JWT から自テナントID を取得
    const jwtTenantId: string | null =
      su?.app_metadata?.tenant_id ?? su?.tenant_id ?? null;
    const requestedTenantId: string =
      (req.query.tenantId as string | undefined) ?? jwtTenantId ?? "";

    // client_admin は自テナントのみ
    if (role === "client_admin") {
      if (!jwtTenantId) {
        return res.status(403).json({ error: "no_tenant", message: "テナントが設定されていません" });
      }
      if (requestedTenantId && requestedTenantId !== jwtTenantId) {
        return res.status(403).json({ error: "forbidden", message: "他のテナントのトークンは発行できません" });
      }
    }

    if (!requestedTenantId) {
      return res.status(400).json({ error: "tenantId_required", message: "tenantId が必要です" });
    }

    const secret = process.env.SUPABASE_JWT_SECRET;
    const expiresIn = 3600; // 1 hour

    if (!secret) {
      // SECRET 未設定環境 (dev) ではフォールバーク値を返す
      return res.json({
        token: `dev-chat-test-${requestedTenantId}`,
        tenantId: requestedTenantId,
        expiresIn,
      });
    }

    const token = jwt.sign(
      { tenant_id: requestedTenantId, purpose: "chat-test" },
      secret,
      { expiresIn }
    );

    return res.json({ token, tenantId: requestedTenantId, expiresIn });
  });

  logger.info("[chatTestRoutes] /v1/admin/chat-test/token registered");
}
