// src/api/middleware/internalNetworkOnly.ts
//
// Defense-in-depth for /metrics, /api/internal/avatar-config, /api/internal/usage.
// The first line of defense is the nginx config (allow 127.0.0.1; deny all
// + nginx-side `X-Internal-Request: 1` injection in the same location).
// This middleware is the Express-side fail-safe: even if nginx is misconfigured
// or bypassed, only TCP peers from the loopback interface reach the handler.
//
// IMPORTANT: We deliberately use `req.socket.remoteAddress` instead of `req.ip`.
// Express's `req.ip` honors `trust proxy` + `X-Forwarded-For`, both of which can
// be influenced by external callers if `trust proxy` is ever turned on by mistake.
// The raw socket peer cannot be spoofed by a header.
//
// Loopback definition (RFC 5735 / RFC 4291):
//   - IPv4: any address in 127.0.0.0/8 (not just 127.0.0.1 — e.g. 127.0.0.2,
//     127.0.1.1 are also loopback). Some test/proxy setups surface alternate
//     forms, and CodeX Round-2 flagged that the literal-set approach would
//     deny benign environments.
//   - IPv6: ::1
//   - IPv4-mapped IPv6: ::ffff:127.0.0.0/8 (dual-stack sockets accepting v4)
//
// Fail-closed: if remoteAddress is undefined, empty, or any non-loopback value,
// deny with 403.

import type { NextFunction, Request, Response } from "express";
import { logger } from "../../lib/logger";

const IPV4_MAPPED_PREFIX = "::ffff:";

function isIpv4InLoopbackRange(addr: string): boolean {
  // strict 4-octet dotted decimal, each 0-255, first octet must be 127.
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map((s) => Number(s));
  if (octets.some((o) => o < 0 || o > 255 || !Number.isInteger(o))) return false;
  return octets[0] === 127;
}

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr || typeof addr !== "string") return false;
  const trimmed = addr.trim();
  if (!trimmed) return false;

  // IPv6 loopback (only canonical "::1" — anything else like "::1%eth0" is
  // a zone-id'd form we treat conservatively below).
  if (trimmed === "::1") return true;

  // IPv4-mapped IPv6: "::ffff:127.x.y.z"
  if (trimmed.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    const v4Part = trimmed.slice(IPV4_MAPPED_PREFIX.length);
    return isIpv4InLoopbackRange(v4Part);
  }

  // Plain IPv4: must be in 127.0.0.0/8.
  return isIpv4InLoopbackRange(trimmed);
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
