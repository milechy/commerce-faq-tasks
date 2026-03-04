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
}

/**
 * Express middleware: tenant-aware sliding-window rate limiter.
 *
 * Position 2 in the chain — runs before auth so it can also throttle
 * unauthenticated flood traffic (keyed by IP). After auth sets tenantId
 * the key switches to tenantId for per-tenant enforcement.
 *
 * When tenantConfig is available (loaded by tenantContextMiddleware),
 * uses `security.rateLimit` and `security.rateLimitWindowMs`.
 */
export function createRateLimitMiddleware(opts: RateLimitOptions = {}) {
  ensureCleanup();

  const { getLimit, logger } = opts;

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const authed = req as Request & { tenantId?: string; tenantConfig?: { security: { rateLimit: number; rateLimitWindowMs: number } } };
    const tenantId: string = authed.tenantId ?? "anonymous";

    const tenantCfg = authed.tenantConfig;
    const limit =
      getLimit?.(tenantId) ??
      tenantCfg?.security.rateLimit ??
      DEFAULT_MAX_REQUESTS;
    const windowMs =
      tenantCfg?.security.rateLimitWindowMs ?? DEFAULT_WINDOW_MS;

    const now = Date.now();
    const entry = getWindow(tenantId, windowMs);
    const current = countRecentRequests(entry, now, windowMs);

    const remaining = Math.max(0, limit - current);
    const resetSec = Math.ceil(entry.resetAt / 1000);

    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSec));

    if (current >= limit) {
      logger?.warn(
        {
          tenantId,
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
        tenantId,
      });
      return;
    }

    entry.timestamps.push(now);
    next();
  };
}
