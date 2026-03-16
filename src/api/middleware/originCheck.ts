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

export function createOriginCheckMiddleware(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> } | null,
  opts: OriginCheckOptions = {}
) {
  return async function originCheckMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
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
        if (origin && !allowedOrigins.includes(origin)) {
          opts.logger?.warn(
            { tenantId, origin, allowedOrigins },
            "origin_rejected_db"
          );
          res.status(403).json({
            error: "origin_not_allowed",
            message: "このオリジンからのアクセスは許可されていません。",
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
