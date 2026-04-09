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
 * ワイルドカードパターンにOriginが一致するか確認。
 * 例: "https://*.example.com" → https://sub.example.com にマッチ
 */
function matchesPattern(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(origin);
  }
  return false;
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
