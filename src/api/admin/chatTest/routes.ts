// src/api/admin/chatTest/routes.ts
import type { Express, NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

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
      console.warn("[chatTestAuth] invalid token", err);
      res.status(401).json({ error: "Invalid token" });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // GET /v1/admin/chat-test/token?tenantId=xxx
  app.get("/v1/admin/chat-test/token", chatTestAuth, async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const role =
      su?.app_metadata?.role ?? su?.user_metadata?.role ?? su?.role ?? "anonymous";

    if (!["super_admin", "client_admin"].includes(role)) {
      return res.status(403).json({ error: "forbidden", message: "管理者ログインが必要です" });
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

  console.log("[chatTestRoutes] /v1/admin/chat-test/token registered");
}
