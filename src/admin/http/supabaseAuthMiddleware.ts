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
  // [P1 fail-closed] 署名検証なしの dev-decode 素通しは opt-in 必須に変更。
  // 従来は NODE_ENV==='development' 単独で JWT を署名検証せず decode して通していたため、
  // 誤って NODE_ENV=development で本番が起動すると認証が実質無効化される fail-open だった。
  // 明示的な ALLOW_INSECURE_DEV_AUTH=1（かつ非production）が揃った時のみに限定し、
  // 既定は下の署名検証必須パスへ落とす。production では flag が付いていても発動しない
  // （多重防御: NODE_ENV=production は常に署名検証）。
  const insecureDevAuthEnabled =
    process.env.NODE_ENV !== "production" &&
    (process.env.ALLOW_INSECURE_DEV_AUTH === "1" ||
      process.env.ALLOW_INSECURE_DEV_AUTH === "true");
  if (insecureDevAuthEnabled) {
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

  // [P1 fail-closed] SUPABASE_JWT_SECRET 未設定時の fail-closed を production 限定から拡張。
  // 従来は production のみ 503 で、それ以外（NODE_ENV 未設定・staging 等を含む）は warn して
  // 素通し（fail-open）だった。「NODE_ENV 未設定=非production 扱い」で認証が無効化される
  // トラップを塞ぐため、fail-closed を「NODE_ENV が development/test 以外の全て」に広げる
  // （internalSecretGuard.ts / authSecretsGuard.ts と同じ「安全な非本番 env のみ寛容」方針）。
  //   - production / staging / NODE_ENV 未設定 → 503 fail-closed
  //   - development / test → warn して素通し（ローカル開発・既存テストを壊さない）
  // 起動時の真の防御は authSecretsGuard ＋ config/env.ts の production 必須化で、ここは二重防御。
  // (リクエスト毎に process.env を読む — 起動後の env 変更やテストの動的設定に追随するため)
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    const nodeEnv = process.env.NODE_ENV ?? "";
    const isSafeNonProdEnv = nodeEnv === "development" || nodeEnv === "test";
    if (!isSafeNonProdEnv) {
      logger.error(
        "[supabaseAuthMiddleware] SUPABASE_JWT_SECRET が設定されていません。認証を拒否します。"
      );
      res.status(503).json({ error: "auth_not_configured" });
      return;
    }
    logger.warn(
      "[supabaseAuthMiddleware] SUPABASE_JWT_SECRET が設定されていないため、認証をスキップします（dev/test のみ）。"
    );
    next();
    return;
  }

  // スキーム名を検証せず空白区切りの2番目をトークン扱いすると、
  // `Basic xxx` / `Foo xxx` のような非Bearerヘッダでも token が取れてしまう
  // (最終的に jwt.verify が弾くため実害は無いが、上のdevelopment分岐と同じ
  // startsWith("Bearer ") チェックに揃える)。
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }
  const token = authHeader.slice("Bearer ".length).trim();

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
