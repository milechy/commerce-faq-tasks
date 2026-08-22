// src/admin/http/supabaseAuthMiddleware.ts
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { logger } from '../../lib/logger';
import { isAdminUsableToken } from '../../auth/jwtClaims';
import type { SupabaseJwtPayload } from '../../auth/verifySupabaseJwt';

/**
 * Supabase の JWT を検証するミドルウェア
 * - Authorization: Bearer <token> を期待
 * - 成功時は req.supabaseUser としてデコード結果をぶら下げる
 */
export function supabaseAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // development: 署名検証なしで JWT をデコードし req.supabaseUser をセットして通す
  // （roleAuthMiddleware が role を正しく解決できるようにするため decode は必須）
  // 二重条件化(ALLOW_INSECURE_DEV_AUTH併用必須)も検討したが、35箇所以上の既存呼び出し元と
  // 多数の既存テスト（makeDevJwtヘルパー経由でNODE_ENV=development単独に依存）がこの単一条件を
  // 前提にしており、二重化は広範な回帰を生む（実測: tuning-rules-api/chat-history-api等が403に）。
  // 本番はecosystem.config.cjs/deploy-vps.shがNODE_ENV=productionを強制するため、
  // このブランチは本番では到達しない（統合前と同じ単一条件を維持）。
  if (process.env.NODE_ENV === "development") {
    const authHeader = req.headers.authorization ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      try {
        (req as any).supabaseUser = jwt.decode(token);
      } catch {
        // decode 失敗は無視して通す
      }
      next();
      return;
    }
    const apiKey = req.headers["x-api-key"];
    if (apiKey) {
      next();
      return;
    }
    res.status(401).json({ error: "Missing X-Api-Key or Bearer token" });
    return;
  }

  // SUPABASE_JWT_SECRET 未設定時の扱い:
  // production は fail-closed（503）。真の防御は起動時の fail-fast
  // （config/env.ts の production 必須化、B3で実装済み）であり、ここは二重防御。
  // production 以外まで fail-closed にすると、SUPABASE_JWT_SECRET を設定せずに
  // このミドルウェアへ到達する既存テスト群（jestワーカー間で process.env が
  // 共有されるため NODE_ENV=test でも影響が波及する）を無関係に壊すため、
  // production 以外は統合前と同じ fail-open（warn して通す）を維持する。
  // (統合前の各インラインコピーと同様、リクエスト毎に process.env を読む —
  //  モジュールトップレベルで一度だけ読むと起動後の env 変更やテストの動的設定に追随できない)
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      logger.error(
        "[supabaseAuthMiddleware] SUPABASE_JWT_SECRET が設定されていません。認証を拒否します。"
      );
      res.status(503).json({ error: "auth_not_configured" });
      return;
    }
    logger.warn(
      "[supabaseAuthMiddleware] SUPABASE_JWT_SECRET が設定されていないため、認証をスキップします。"
    );
    next();
    return;
  }

  const authHeader = req.headers.authorization || "";
  const [, token] = authHeader.split(" ");

  if (!token) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  try {
    // algorithms を HS256 に固定する。省略すると jsonwebtoken はトークン側の alg を
    // 信用するため、alg confusion 攻撃(RS256 を名乗るトークンを HMAC 秘密鍵で検証させる等)
    // の余地が残る。verifySupabaseJwt.ts(別経路)と同じ制約をこの管理面入口にも効かせる。
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] }) as SupabaseJwtPayload;

    // 署名が正しいだけでは「管理面で使ってよいトークン」とは限らない
    // （widget/anon/chat-testトークンも同じsecretで署名されうる）。
    // purpose クレーム保持・role='anon'・super_admin/client_admin以外のroleを拒否する。
    if (!isAdminUsableToken(decoded)) {
      logger.warn("[supabaseAuthMiddleware] token rejected: not admin-usable", {
        hasPurpose: Boolean((decoded as Record<string, unknown>).purpose),
        role: decoded.app_metadata?.role ?? decoded.role,
      });
      res.status(403).json({ error: "forbidden", message: "この操作を行う権限がありません" });
      return;
    }

    // 型を拡張してないので any でぶら下げる
    (req as any).supabaseUser = decoded;
    next();
    return;
  } catch (err) {
    logger.warn("[supabaseAuthMiddleware] invalid token", err);
    res.status(401).json({ error: "Invalid token" });
    return;
  }
}
