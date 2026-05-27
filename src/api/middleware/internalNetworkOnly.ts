// src/api/middleware/internalNetworkOnly.ts
//
// Defense-in-depth for /metrics, /api/internal/avatar-config, /api/internal/usage.
// The first line of defense is the nginx config (allow 127.0.0.1; deny all + header strip).
// This middleware is the Express-side fail-safe: even if nginx is misconfigured or bypassed,
// only TCP peers from the loopback interface reach the handler.
//
// IMPORTANT: We deliberately use `req.socket.remoteAddress` instead of `req.ip`.
// Express's `req.ip` honors `trust proxy` + `X-Forwarded-For`, both of which can be
// influenced by external callers if `trust proxy` is ever turned on by mistake.
// The raw socket peer cannot be spoofed by a header.
//
// Fail-closed: if remoteAddress is undefined, missing, or any non-loopback value, deny.

import type { NextFunction, Request, Response } from "express";
import { logger } from "../../lib/logger";

const LOOPBACK_ADDRESSES = new Set<string>([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1", // IPv4-mapped IPv6
]);

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return LOOPBACK_ADDRESSES.has(addr);
}

export function internalNetworkOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const remote = req.socket?.remoteAddress;
  if (!isLoopbackAddress(remote)) {
    logger.warn(
      {
        path: req.path,
        method: req.method,
        remoteAddress: remote ?? "unknown",
        xff: req.headers["x-forwarded-for"] ?? null,
      },
      "[internalNetworkOnly] denied non-loopback caller",
    );
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}
