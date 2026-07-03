import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";

export interface CorsOptions {
  /** Origins allowed globally (fallback when tenant config is unavailable) */
  defaultAllowedOrigins?: string[];
  /**
   * Checks whether `origin` is registered as an allowed domain for at least
   * one tenant (DB-backed, in-memory tenantStore). tenantId is not yet known
   * at the OPTIONS preflight stage, so this can only confirm "some tenant
   * allows this origin" — the actual request still goes through per-tenant
   * enforcement (securityPolicy / originCheck) once tenantId is resolved.
   */
  isKnownTenantOrigin?: (origin: string) => boolean;
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
 * Pre-auth: tenantId is not resolved yet, so OPTIONS preflight cannot do
 * per-tenant enforcement. It allows origins that are either in the global
 * ALLOWED_ORIGINS env allowlist or registered as an allowed domain for at
 * least one tenant (isKnownTenantOrigin). The actual request still passes
 * through per-tenant enforcement (securityPolicy / originCheck, later in
 * apiStack) once tenantId is resolved from the API key/JWT.
 */
export function createCorsMiddleware(opts: CorsOptions = {}) {
  const allowedSet = new Set(opts.defaultAllowedOrigins ?? []);

  return function corsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const origin = req.headers.origin;

    const isAllowed =
      !!origin &&
      (allowedSet.size === 0 ||
        allowedSet.has(origin) ||
        (opts.isKnownTenantOrigin?.(origin) ?? false));

    if (isAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin as string);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
