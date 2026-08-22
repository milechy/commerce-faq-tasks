import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import type { AuthedRequest } from "../agent/http/authMiddleware";
import { isOriginAllowed } from "../api/middleware/originCheck";

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

    // chat-test tokens are admin-issued (from /admin/chat-test); skip per-tenant
    // origin enforcement here too — originCheck.ts already does this, but this
    // middleware runs earlier in the apiStack and was rejecting chat-test avatar
    // calls (anam-session / room-token) with origin_not_allowed before reaching it.
    if ((req as any).isChatTestToken) {
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
    // 照合は originCheck.ts の isOriginAllowed に一本化する。以前はここだけ完全一致
    // (allowed.includes)で、DB側の originCheck.ts だけがワイルドカードを解釈していた。
    // securityPolicy の方が apiStack で先に走るため、UIが案内している
    // `https://*.example.com` は実テナントでは常に403になり機能していなかった。
    const allowed = config.security.allowedOrigins;
    if (allowed.length > 0) {
      const origin = req.headers.origin;
      if (origin && !isOriginAllowed(origin, allowed)) {
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
