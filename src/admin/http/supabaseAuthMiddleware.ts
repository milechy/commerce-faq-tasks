// src/admin/http/supabaseAuthMiddleware.ts
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { logger } from '../../lib/logger';

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
  // development: 署名検証なしで JWT をデコードし req.supabaseUser をセットして通す
  // （roleAuthMiddleware が role を正しく解決できるようにするため decode は必須）
  // NODE_ENV==="development" だけでは誤って本番相当の環境で発動しうるため、
  // ALLOW_INSECURE_DEV_AUTH="true" の明示指定を併せて要求する（二重条件）。
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_INSECURE_DEV_AUTH === "true"
  ) {
    const authHeader = req.headers.authorization ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      try {
        (req as any).supabaseUser = jwt.decode(token);
      } catch {
        // decode 失敗は無視して通す
      }
      return next();
    }
    const apiKey = req.headers["x-api-key"];
    if (apiKey) return next();
    return res.status(401).json({ error: "Missing X-Api-Key or Bearer token" });
  }

  // SUPABASE_JWT_SECRET 未設定は fail-closed。
  // スキップして通すと認証丸ごとバイパスになるため、設定ミスは拒否で顕在化させる。
  // (統合前の各インラインコピーと同様、リクエスト毎に process.env を読む —
  //  モジュールトップレベルで一度だけ読むと起動後の env 変更やテストの動的設定に追随できない)
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    logger.error(
      "[supabaseAuthMiddleware] SUPABASE_JWT_SECRET が設定されていません。認証を拒否します。"
    );
    return res.status(503).json({ error: "auth_not_configured" });
  }

  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");

  if (!token) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const decoded = jwt.verify(token, secret);

    // 必要ならここでロールチェック (e.g. decoded["role"] === "service_role" など)
    // logger.info("[supabaseAuth] decoded =", decoded);

    // 型を拡張してないので any でぶら下げる
    (req as any).supabaseUser = decoded;
    return next();
  } catch (err) {
    logger.warn("[supabaseAuthMiddleware] invalid token", err);
    return res.status(401).json({ error: "Invalid token" });
  }
}
