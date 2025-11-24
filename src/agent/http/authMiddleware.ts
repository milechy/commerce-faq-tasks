import type { NextFunction, Request, Response } from "express";
import {
  SupabaseJwtPayload,
  verifySupabaseJwt,
} from "../../auth/verifySupabaseJwt";

const API_KEY = process.env.API_KEY;
const BASIC_USER = process.env.BASIC_USER;
const BASIC_PASS = process.env.BASIC_PASS;

export interface AuthedRequest extends Request {
  authUser?: SupabaseJwtPayload;
  tenantId?: string;
}

export function initAuthMiddleware() {
  console.info("[auth] Auth middleware initialized", {
    hasApiKey: !!API_KEY,
    hasBasic: !!BASIC_USER && !!BASIC_PASS,
    hasSupabaseJwtSecret: !!process.env.SUPABASE_JWT_SECRET,
  });

  return function authMiddleware(
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ) {
    // 1) 既存の API Key 認証
    const apiKeyHeader = req.header("x-api-key");
    if (API_KEY && apiKeyHeader === API_KEY) {
      // テナントはヘッダ or ボディ or デフォルト
      req.tenantId =
        (req.header("x-tenant-id") as string | undefined) ||
        (req.body?.tenantId as string | undefined) ||
        "default";
      return next();
    }

    // 2) 既存の Basic 認証
    const authHeader = req.header("authorization") || "";
    if (BASIC_USER && BASIC_PASS && authHeader.startsWith("Basic ")) {
      const encoded = authHeader.replace("Basic ", "");
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const [user, pass] = decoded.split(":", 2);
      if (user === BASIC_USER && pass === BASIC_PASS) {
        req.tenantId =
          (req.header("x-tenant-id") as string | undefined) ||
          (req.body?.tenantId as string | undefined) ||
          "default";
        return next();
      }
    }

    // 3) 新しく追加する Supabase Auth (JWT)
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "").trim();
      const payload = verifySupabaseJwt(token);

      if (payload) {
        req.authUser = payload;

        // 将来、JWT のカスタムクレームに tenant_id を入れたらここで使う
        // (今はなければ 'demo' をデフォルトにしておく)
        req.tenantId =
          payload.tenant_id ||
          (req.header("x-tenant-id") as string | undefined) ||
          (req.body?.tenantId as string | undefined) ||
          "demo";

        return next();
      }
    }

    // 4) どれも通らなかったら 401
    return res.status(401).json({
      error: "unauthorized",
      message:
        "Valid x-api-key, Basic auth, or Supabase JWT (Authorization: Bearer) is required.",
    });
  };
}
