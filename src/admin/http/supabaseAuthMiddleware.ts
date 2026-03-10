// src/admin/http/supabaseAuthMiddleware.ts
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

/**
 * Supabase の JWT を検証するミドルウェア
 * - Authorization: Bearer <token> を期待
 * - 成功時は req.supabaseUser としてデコード結果をぶら下げる
 */
export function supabaseAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // development: X-Api-Key または Bearer token で認証を通す
  if (process.env.NODE_ENV === "development") {
    const apiKey = req.headers["x-api-key"];
    if (apiKey) return next();
    const authHeader = req.headers.authorization ?? "";
    if (authHeader.startsWith("Bearer ")) return next();
    return res.status(401).json({ error: "Missing X-Api-Key or Bearer token" });
  }

  // SUPABASE_JWT_SECRET 未設定時はスキップ（非 production 環境向け）
  if (!SUPABASE_JWT_SECRET) {
    console.warn(
      "[supabaseAuthMiddleware] SUPABASE_JWT_SECRET が設定されていないため、認証をスキップします。"
    );
    return next();
  }

  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");

  if (!token) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const decoded = jwt.verify(token, SUPABASE_JWT_SECRET);

    // 必要ならここでロールチェック (e.g. decoded["role"] === "service_role" など)
    // console.log("[supabaseAuth] decoded =", decoded);

    // 型を拡張してないので any でぶら下げる
    (req as any).supabaseUser = decoded;
    return next();
  } catch (err) {
    console.warn("[supabaseAuthMiddleware] invalid token", err);
    return res.status(401).json({ error: "Invalid token" });
  }
}
