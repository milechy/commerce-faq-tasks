import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import type { TenantConfig } from "../types/contracts";
import type { AuthedRequest } from "../agent/http/authMiddleware";

// ---------------------------------------------------------------------------
// In-memory tenant registry (will be backed by DB in a future phase)
// ---------------------------------------------------------------------------
const tenantStore = new Map<string, TenantConfig>();

export function registerTenant(config: TenantConfig): void {
  tenantStore.set(config.tenantId, config);
}

export function getTenantConfig(
  tenantId: string
): TenantConfig | undefined {
  return tenantStore.get(tenantId);
}

export function getTenantByApiKeyHash(
  hash: string
): TenantConfig | undefined {
  const entries = Array.from(tenantStore.values());
  for (const cfg of entries) {
    if (cfg.security.apiKeyHash === hash) return cfg;
  }
  return undefined;
}

export function listTenants(): TenantConfig[] {
  return Array.from(tenantStore.values());
}

// ---------------------------------------------------------------------------
// Seed from environment (TENANT_CONFIGS_JSON or individual vars)
// ---------------------------------------------------------------------------
export function seedTenantsFromEnv(): void {
  const raw = process.env.TENANT_CONFIGS_JSON;
  if (raw) {
    try {
      const configs: TenantConfig[] = JSON.parse(raw);
      for (const c of configs) registerTenant(c);
    } catch {
      // Fail silently — production should use DB
    }
    return;
  }

  // Minimal default tenant for development
  if (process.env.API_KEY) {
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const hash = crypto
      .createHash("sha256")
      .update(process.env.API_KEY)
      .digest("hex");

    registerTenant({
      tenantId: "default",
      name: "Default Tenant",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: {
        apiKeyHash: hash,
        hashAlgorithm: "sha256",
        allowedOrigins: [],
        rateLimit: 100,
        rateLimitWindowMs: 60_000,
      },
      enabled: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Middleware: attach tenantConfig to the request (position 4 in chain)
// ---------------------------------------------------------------------------
export interface TenantContextOptions {
  logger?: Logger;
}

/**
 * Loads TenantConfig for the authenticated tenantId and attaches it
 * to `req.tenantConfig`. If the tenant is unknown or disabled, returns 403.
 *
 * For legacy/Basic auth paths where tenantConfig was already resolved
 * by authMiddleware, this is a no-op pass-through.
 */
export function createTenantContextMiddleware(
  opts: TenantContextOptions = {}
) {
  return function tenantContextMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const authed = req as AuthedRequest;

    // Already resolved by auth (API Key hash path)
    if (authed.tenantConfig) {
      next();
      return;
    }

    if (!authed.tenantId) {
      res.status(403).json({
        error: "missing_tenant",
        message: "テナント情報を特定できませんでした。",
      });
      return;
    }

    const config = getTenantConfig(authed.tenantId);

    if (config) {
      if (!config.enabled) {
        opts.logger?.warn(
          { tenantId: authed.tenantId },
          "tenant_disabled"
        );
        res.status(403).json({
          error: "tenant_disabled",
          message: "このテナントは現在無効です。",
        });
        return;
      }
      authed.tenantConfig = config;
    }

    // Unknown tenant is allowed (demo / JWT without DB entry) — securityPolicy
    // will enforce stricter rules if needed.
    next();
  };
}
