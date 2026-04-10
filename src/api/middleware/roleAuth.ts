// src/api/middleware/roleAuth.ts
// Phase34: ロールベース認証ミドルウェア
import type { NextFunction, Request, Response } from "express";

export type UserRole = "super_admin" | "client_admin" | "anonymous";

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
  user_metadata?: { role?: string; tenant_id?: string };
};

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

  const role: UserRole =
    (supabaseUser.app_metadata?.role as UserRole | undefined) ||
    (supabaseUser.user_metadata?.role as UserRole | undefined) ||
    "anonymous";

  const tenantId: string | null =
    supabaseUser.app_metadata?.tenant_id ||
    supabaseUser.user_metadata?.tenant_id ||
    null;

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

/**
 * client_admin が自テナントのデータのみアクセスできるようにする
 * super_admin はすべてのテナントにアクセス可能
 */
export function requireOwnTenant() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedReq).user;

    // super_admin はすべてのテナントにアクセス可能
    if (user?.role === "super_admin") {
      return next();
    }

    const requestedTenant =
      (req.params.tenantId as string | undefined) ||
      (req.query.tenant as string | undefined) ||
      (req.query.tenant_id as string | undefined) ||
      (req.headers["x-tenant-id"] as string | undefined);

    if (requestedTenant && requestedTenant !== user?.tenantId) {
      res.status(403).json({
        error: "forbidden",
        message: "他のテナントのデータにはアクセスできません",
      });
      return;
    }

    // client_admin のリクエストに tenant_id が未指定なら自動付与
    if (!requestedTenant && user?.tenantId) {
      req.query.tenant = user.tenantId;
    }

    next();
  };
}
