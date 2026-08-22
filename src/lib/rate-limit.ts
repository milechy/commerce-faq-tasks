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
  /**
   * Override the limit for a resolved bucket key. Falls back to TenantConfig
   * or DEFAULT. The key is the *prefixed* bucket key actually used to bucket
   * requests (e.g. `tenant:acme`, `ip:1.2.3.4`, or the unprefixed legacy
   * `acme` / `anonymous` when `stage` is unset) — NOT a raw tenantId. A
   * callback written as `(tenantId) => plans[tenantId]` will silently miss
   * (`plans['tenant:acme']` is undefined) and fall through to DEFAULT with
   * no error, so treat the argument as an opaque key, not a tenantId.
   */
  getLimit?: (key: string) => number | undefined;
  logger?: Logger;
  /**
   * 'ip'    — pre-auth stage: key by nginx-injected X-Real-IP (flood/DDoS
   *           protection before tenantId is known). Falls back to req.ip
   *           when the header is absent (e.g. direct/local requests).
   * 'tenant'— post-auth stage: key by tenantId, prefixed `tenant:` to keep
   *           its namespace independent from the 'ip' stage's `ip:` prefix.
   * unset   — legacy/back-compat: keys by the *unprefixed* tenantId
   *           (`authed.tenantId ?? "anonymous"`). This is NOT the same
   *           bucket namespace as 'tenant' (which prefixes with `tenant:`) —
   *           the two stages share no buckets. New call sites must specify
   *           `stage` explicitly; leave this branch only for pre-existing
   *           unmigrated callers.
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
    } else if (stage === "tenant") {
      // ip段と対称の名前空間にする（`tenant:`接頭辞）。tenantIdのバリデーション
      // (`/^[a-z0-9_-]+$/`、コロン不可）により現状 ip段のキーと衝突する余地は無いが、
      // 将来バリデーションが緩和された場合の防御として、両段を完全に独立させる。
      key = `tenant:${authed.tenantId ?? "anonymous"}`;
    } else {
      // stage未指定（legacy/back-compat）: 既存呼び出し元（stage移行前）と
      // 完全に同一のキー形式を維持する。新規呼び出しは必ず stage を指定すること。
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
