// src/api/middleware/roleAuth.ts
// Phase34: ロールベース認証ミドルウェア
import type { NextFunction, Request, Response } from "express";

export type UserRole = "super_admin" | "client_admin" | "anonymous";

// 管理者ロール allowlist（admin 系ルートの認可判定で共有）。
// 旧来 chat-history / analytics / eventAnalytics に重複定義されていたものを集約。
export const ALLOWED_ADMIN_ROLES = ["super_admin", "client_admin"] as const;
export type AllowedAdminRole = (typeof ALLOWED_ADMIN_ROLES)[number];
/**
 * actor のロールが admin 系（super_admin / client_admin）か判定する型ガード。
 * セキュリティ要件: 認可ロールは app_metadata.role のみを信頼すること
 * （user_metadata はクライアント編集可能なため特権判定に使用してはならない）。
 */
export function isAllowedAdminRole(role: unknown): role is AllowedAdminRole {
  return (
    typeof role === "string" &&
    (ALLOWED_ADMIN_ROLES as readonly string[]).includes(role)
  );
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  tenantId: string | null;
}

export type SupabaseJwtUser = {
  sub?: string;
  id?: string;
  email?: string;
  tenant_id?: string;
  app_metadata?: { role?: string; tenant_id?: string };
  // user_metadata は Supabase JWT に存在するがクライアント制御可能なため、
  // 認可ロジックでは使用してはならない（型定義のみ保持）
  user_metadata?: { role?: string; tenant_id?: string };
};

// セキュリティ要件: JWT claim を安全に string として取得する
// typeof ガードにより any/undefined を "" にフォールバック（実行時保証）
function safeStringClaim(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export type AuthedReq = Request & {
  supabaseUser?: SupabaseJwtUser;
  user?: AuthenticatedUser;
};

/**
 * req.supabaseUser からロール情報を読み取り req.user に付与する
 * supabaseAuthMiddleware の後に使用すること
 */
export function roleAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const supabaseUser = (req as AuthedReq).supabaseUser;

  if (!supabaseUser) {
    (req as AuthedReq).user = {
      id: "",
      email: "",
      role: "anonymous" as UserRole,
      tenantId: null,
    };
    return next();
  }

  // セキュリティ要件: ロール / テナントスコープは app_metadata のみを信頼する
  // user_metadata はクライアント制御可能なため、特権判定に使用してはならない
  const rawRole = safeStringClaim(supabaseUser.app_metadata?.role);
  const role: UserRole =
    rawRole === "super_admin" || rawRole === "client_admin" ? rawRole : "anonymous";

  const rawTenantId = safeStringClaim(supabaseUser.app_metadata?.tenant_id);
  const tenantId: string | null = rawTenantId || null;

  // セキュリティ要件: client_admin は必ず tenant_id を持つこと
  // 防御深度: ミドルウェア層と route 層の両方で fail-closed
  if (role === "client_admin" && (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "")) {
    res.status(403).json({ error: "この操作を実行する権限がありません" });
    return;
  }

  (req as AuthedReq).user = {
    id: supabaseUser.sub || supabaseUser.id || "",
    email: supabaseUser.email || "",
    role,
    tenantId,
  };

  next();
}

/**
 * 指定ロールのいずれかであることを要求する
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedReq).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({
        error: "forbidden",
        message: "この操作を行う権限がありません",
      });
      return;
    }
    next();
  };
}

// NOTE: 旧 `requireOwnTenant()` ヘルパーは削除済み（Phase70 / Phase44-46 棚卸し結論）。
// テナント分離は各 per-tenant ルート内で個別に実装されている等価ロジックで担保されており、
// 一律ミドルウェアの再配線は不要と確認した。代表例:
//   - src/api/admin/knowledge/routes.ts:282 `requireKnowledgeTenant`
//   - src/api/admin/chatTest/routes.ts:78    インライン check
//   - src/api/admin/chat-history/routes.ts:54 `app_metadata.tenant_id` を直接 SQL フィルタに使用
// 詳細: PR #207 (feature/1215114203188918-remove-dead-requireOwnTenant)
