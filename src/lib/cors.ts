import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";

export interface CorsOptions {
  /** Origins allowed globally (fallback when tenant config is unavailable) */
  defaultAllowedOrigins?: string[];
  logger?: Logger;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "X-Tenant-ID",
  "X-Request-ID",
].join(", ");
const EXPOSED_HEADERS = [
  "X-Request-ID",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
].join(", ");

/**
 * CORS middleware — position 1 in the chain.
 *
 * Pre-auth: only the global allowlist is available.
 * Per-tenant origin enforcement is handled later by securityPolicyEnforcer
 * (position 5) once tenantConfig is loaded.
 */
export function createCorsMiddleware(opts: CorsOptions = {}) {
  const allowedSet = new Set(opts.defaultAllowedOrigins ?? []);

  return function corsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const origin = req.headers.origin;

    if (origin && (allowedSet.size === 0 || allowedSet.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
