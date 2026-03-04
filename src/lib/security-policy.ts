import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import type { AuthedRequest } from "../agent/http/authMiddleware";

export interface SecurityPolicyOptions {
  logger?: Logger;
  /** Skip origin enforcement for these paths (e.g. internal health checks) */
  skipPaths?: Set<string>;
}

/**
 * Per-tenant security policy enforcer — position 5 in the chain.
 *
 * Runs AFTER authMiddleware + tenantContextLoader so that both
 * `req.tenantId` and `req.tenantConfig` are available.
 *
 * Checks:
 *  1. Origin vs tenant's allowedOrigins (skip if allowedOrigins is empty)
 *  2. Future: IP allowlisting, request signing, etc.
 */
export function createSecurityPolicyMiddleware(
  opts: SecurityPolicyOptions = {}
) {
  const skipPaths = opts.skipPaths ?? new Set(["/ce/status", "/ui", "/health", "/metrics"]);

  return function securityPolicyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (skipPaths.has(req.path)) {
      next();
      return;
    }

    const authed = req as AuthedRequest;
    const config = authed.tenantConfig;

    // No config loaded — pass through (demo tenants / legacy paths)
    if (!config) {
      next();
      return;
    }

    // --- Origin enforcement ---
    const allowed = config.security.allowedOrigins;
    if (allowed.length > 0) {
      const origin = req.headers.origin;
      if (origin && !allowed.includes(origin)) {
        opts.logger?.warn(
          {
            tenantId: authed.tenantId,
            origin,
            allowedOrigins: allowed,
          },
          "origin_rejected"
        );
        res.status(403).json({
          error: "origin_not_allowed",
          message: "このオリジンからのアクセスは許可されていません。",
        });
        return;
      }
    }

    next();
  };
}
