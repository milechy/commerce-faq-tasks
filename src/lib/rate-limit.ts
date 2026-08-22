import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";

const DEFAULT_WINDOW_MS = 60_000; // 1 min
const DEFAULT_MAX_REQUESTS = 100;

type WindowEntry = {
  timestamps: number[];
  resetAt: number;
};

const store = new Map<string, WindowEntry>();

const CLEANUP_INTERVAL_MS = 5 * 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

function ensureCleanup(): void {
  if (cleanupTimer !== undefined) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of Array.from(store.entries())) {
      if (entry.resetAt < now) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function getWindow(key: string, windowMs: number): WindowEntry {
  const now = Date.now();
  const existing = store.get(key);

  if (existing && existing.resetAt > now) {
    return existing;
  }

  const entry: WindowEntry = {
    timestamps: [],
    resetAt: now + windowMs,
  };
  store.set(key, entry);
  return entry;
}

function countRecentRequests(
  entry: WindowEntry,
  now: number,
  windowMs: number
): number {
  const windowStart = now - windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  return entry.timestamps.length;
}

export interface RateLimitOptions {
  /** Override per-tenant limit. Falls back to TenantConfig or DEFAULT. */
  getLimit?: (tenantId: string) => number | undefined;
  logger?: Logger;
  /**
   * 'ip'    — pre-auth stage: key by nginx-injected X-Real-IP (flood/DDoS
   *           protection before tenantId is known). Falls back to req.ip
   *           when the header is absent (e.g. direct/local requests).
   * 'tenant'— post-auth stage: key by tenantId (current default behavior).
   * unset   — legacy behavior, identical to 'tenant' (backward compatible).
   */
  stage?: "ip" | "tenant";
}

const ANONYMOUS_IP_KEY = "unknown-ip";

/**
 * Express middleware: sliding-window rate limiter, staged.
 *
 * Two instances run in `apiStack`:
 *   1. pre-auth (`stage: 'ip'`)     — throttles by X-Real-IP, catches
 *      unauthenticated flood traffic before any tenantId exists.
 *   2. post-auth (`stage: 'tenant'`)— throttles by tenantId, so one
 *      client can no longer exhaust every tenant's shared "anonymous"
 *      bucket (the bug this stage split fixes).
 *
 * When tenantConfig is available (loaded by tenantContextMiddleware),
 * uses `security.rateLimit` and `security.rateLimitWindowMs`.
 */
export function createRateLimitMiddleware(opts: RateLimitOptions = {}) {
  ensureCleanup();

  const { getLimit, logger, stage } = opts;

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const authed = req as Request & { tenantId?: string; tenantConfig?: { security: { rateLimit: number; rateLimitWindowMs: number } } };

    let key: string;
    if (stage === "ip") {
      const realIp = req.header("x-real-ip")?.trim();
      if (realIp) {
        key = `ip:${realIp}`;
      } else {
        logger?.warn(
          { requestId: req.requestId },
          "rate_limit_missing_x_real_ip"
        );
        key = `ip:${req.ip ?? ANONYMOUS_IP_KEY}`;
      }
    } else {
      // stage === "tenant" or unset (legacy/back-compat)
      key = authed.tenantId ?? "anonymous";
    }

    const tenantCfg = authed.tenantConfig;
    const limit =
      getLimit?.(key) ??
      tenantCfg?.security.rateLimit ??
      DEFAULT_MAX_REQUESTS;
    const windowMs =
      tenantCfg?.security.rateLimitWindowMs ?? DEFAULT_WINDOW_MS;

    const now = Date.now();
    const entry = getWindow(key, windowMs);
    const current = countRecentRequests(entry, now, windowMs);

    const remaining = Math.max(0, limit - current);
    const resetSec = Math.ceil(entry.resetAt / 1000);

    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSec));

    if (current >= limit) {
      logger?.warn(
        {
          key,
          stage: stage ?? "tenant",
          requestId: req.requestId,
          limit,
          current,
        },
        "rate_limit_exceeded"
      );

      res.setHeader(
        "Retry-After",
        String(Math.ceil(windowMs / 1000))
      );
      res.status(429).json({
        error: "rate_limit_exceeded",
        message:
          "リクエスト数の上限に達しました。しばらくしてから再試行してください。",
        requestId: req.requestId,
        tenantId: authed.tenantId ?? "anonymous",
      });
      return;
    }

    entry.timestamps.push(now);
    next();
  };
}
