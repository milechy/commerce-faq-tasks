// src/api/middleware/originCheck.ts
//
// Async per-tenant Origin enforcement backed by the DB tenants.allowed_origins column.
// Runs after authMiddleware (req.tenantId is set) in the apiStack.
// If allowed_origins is empty → allow all (backward-compatible).
// If non-empty → reject origins not in the list with 403.

import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";

interface OriginCheckOptions {
  logger?: Logger;
}

/**
 * ワイルドカードを許可する唯一の形は「ホスト先頭ラベルを `*` に置き換えたサブドメイン指定」。
 *
 *   OK: https://*.example.com  → https://sub.example.com / https://a.b.example.com
 *   NG: https://*              → 全 https オリジンにマッチしてしまう
 *   NG: https://*evil.com      → https://notevil.com にもマッチしてしまう
 *   NG: https://*.a.*.com      → `*` は1個まで
 *
 * 形を縛る理由: allowedOrigins は tenant-context.ts の isOriginKnownToAnyTenant 経由で
 * CORS(cors.ts)にも使われる。1テナントが `https://*` を登録するだけで、全テナントに対して
 * 任意オリジンが Access-Control-Allow-Origin に反射される(しかも credentials 付き)。
 * 保存時バリデーション(admin/tenants/routes.ts)と二重に効かせることで、手動UPDATE等で
 * 入り込んだ危険なパターンも照合側で無効化する。
 */
const SAFE_WILDCARD_PATTERN = /^https:\/\/\*\.[^*/]+$/;

/**
 * allowedOrigins に保存してよい形かどうか。保存時バリデーションと照合の双方で使う。
 * ワイルドカードを含まない値は https:// 始まりであれば許可する(既存データ互換)。
 */
export function isValidOriginPattern(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  if (!value.includes("*")) return true;
  return SAFE_WILDCARD_PATTERN.test(value);
}

/**
 * ワイルドカードパターンにOriginが一致するか確認。
 * 例: "https://*.example.com" → https://sub.example.com にマッチ
 */
function matchesPattern(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.includes("*")) return false;
  // 危険な形は照合対象にしない(保存時に弾いているが、過去データ・手動UPDATEへの保険)
  if (!SAFE_WILDCARD_PATTERN.test(pattern)) return false;
  // エスケープ(`.`→`\.`)を先に済ませてから `*` を展開する順序を保つ。
  // 展開先を `.*` ではなく `[^/]+` にして、空マッチとパス混入を防ぐ。
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+");
  return new RegExp(`^${escaped}$`).test(origin);
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((pattern) => matchesPattern(origin, pattern));
}

export function createOriginCheckMiddleware(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> } | null,
  opts: OriginCheckOptions = {}
) {
  return async function originCheckMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // chat-test tokens are admin-issued; skip per-tenant origin enforcement
    if ((req as any).isChatTestToken) {
      next();
      return;
    }

    if (!db) {
      next();
      return;
    }

    const tenantId = (req as any).tenantId as string | undefined;
    if (!tenantId) {
      next();
      return;
    }

    try {
      const result = await db.query(
        "SELECT allowed_origins FROM tenants WHERE id = $1",
        [tenantId]
      );
      const allowedOrigins: string[] = result.rows[0]?.allowed_origins ?? [];

      if (allowedOrigins.length > 0) {
        const origin = req.headers.origin;
        if (origin && !isOriginAllowed(origin, allowedOrigins)) {
          opts.logger?.warn(
            { tenantId, origin, allowedOrigins },
            "origin_rejected_db"
          );
          res.status(403).json({
            error: "origin_not_allowed",
            message: "このドメインからのアクセスは許可されていません。",
          });
          return;
        }
      }
    } catch (err) {
      // DB unavailable — fail open to avoid breaking the service
      opts.logger?.warn({ tenantId, err }, "origin_check_db_error");
    }

    next();
  };
}
