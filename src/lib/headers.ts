import type { NextFunction, Request, Response } from "express";

/**
 * Express middleware: API サーバ向けセキュリティヘッダを全レスポンスに付与する。
 *
 * 適用ヘッダ:
 * - Strict-Transport-Security  : HTTPS 強制（1年 + サブドメイン）
 * - X-Content-Type-Options     : MIME スニッフィング防止
 * - X-Frame-Options            : クリックジャッキング防止
 * - Content-Security-Policy    : API サーバは全ソースをブロック
 * - Referrer-Policy            : リファラ情報漏洩防止
 * - Permissions-Policy         : 不要ブラウザ API を無効化
 * - Cache-Control              : API レスポンスをキャッシュさせない
 * - X-Powered-By               : 削除（app.disable で対応、ここでも念のため）
 */
export function securityHeadersMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.removeHeader("X-Powered-By");

  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  next();
}
