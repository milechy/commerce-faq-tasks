import type { NextFunction, Request, Response } from "express";

/**
 * Supabase JWT の app_metadata.role が "super_admin" であることを確認するミドルウェア
 * supabaseAuthMiddleware の後に使用すること
 */
export function superAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // development: 環境変数SUPER_ADMIN_BYPASS=trueでスキップ
  if (process.env.NODE_ENV === "development" && process.env.SUPER_ADMIN_BYPASS === "true") {
    return next();
  }

  const user = (req as any).supabaseUser;
  if (!user) {
    res.status(401).json({ error: "unauthorized", message: "認証が必要です。" });
    return;
  }

  // セキュリティ要件: ロールは app_metadata.role のみを信頼する
  // user_metadata / top-level role はクライアント制御可能なため使用してはならない
  const rawRole = user.app_metadata?.role;
  const role: string = typeof rawRole === "string" ? rawRole : "";

  if (role !== "super_admin") {
    res.status(403).json({ error: "forbidden", message: "Super Admin権限が必要です。" });
    return;
  }

  next();
}
