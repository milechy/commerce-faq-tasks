import { timingSafeEqual, createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import type { Pool } from "pg";
import type { TenantConfig } from "../types/contracts";
import type { AuthedRequest } from "../agent/http/authMiddleware";
import { isOriginAllowed } from "../api/middleware/originCheck";

// ---------------------------------------------------------------------------
// In-memory tenant registry (DB-backed via seedTenantsFromDB at startup)
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

function safeCompare(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function getTenantByApiKeyHash(
  hash: string
): TenantConfig | undefined {
  const entries = Array.from(tenantStore.values());
  for (const cfg of entries) {
    if (safeCompare(cfg.security.apiKeyHash, hash)) return cfg;
  }
  return undefined;
}

/**
 * CORS preflight (OPTIONS) はテナントID未確定の段階で応答が必要なため、
 * 単一テナントの allowedOrigins ではなく「いずれかのテナントが許可しているか」で判定する。
 * 実リクエスト側の tenantContext / securityPolicy / originCheck が引き続きテナント単位の
 * 厳密な検証を行うので、ここでの判定を緩めても最終的なアクセス制御は変わらない。
 */
export function isOriginKnownToAnyTenant(origin: string): boolean {
  for (const cfg of tenantStore.values()) {
    if (isOriginAllowed(origin, cfg.security.allowedOrigins)) return true;
  }
  return false;
}

/**
 * Update only the `enabled` flag of an existing in-memory tenant.
 * Used by kill-switch and PATCH is_active to propagate DB changes instantly
 * without requiring PM2 restart.
 * Returns true if tenant was found in store, false if not (DB-only tenant).
 */
export function updateTenantEnabled(tenantId: string, enabled: boolean): boolean {
  const existing = tenantStore.get(tenantId);
  if (!existing) return false;
  tenantStore.set(tenantId, { ...existing, enabled });
  return true;
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

  // Support API_KEY / API_KEY_TENANT_ID and API_KEY_2 / API_KEY_2_TENANT_ID ... API_KEY_10
  const keyEntries: Array<{ key: string; tenantId: string }> = [];

  // API_KEY (no suffix) with API_KEY_TENANT_ID
  const baseKey = process.env.API_KEY;
  if (baseKey) {
    const tenantId = process.env.API_KEY_TENANT_ID || "default";
    keyEntries.push({ key: baseKey, tenantId });
  }

  // API_KEY_2 ... API_KEY_10 with corresponding TENANT_ID
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`API_KEY_${i}`];
    if (!k) continue;
    const tenantId = process.env[`API_KEY_${i}_TENANT_ID`] || `tenant_${i}`;
    keyEntries.push({ key: k, tenantId });
  }

  for (const { key, tenantId } of keyEntries) {
    const hash = createHash("sha256").update(key).digest("hex");
    registerTenant({
      tenantId,
      name: tenantId,
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
// Seed from DB (tenant_api_keys + tenants JOIN) — call once at startup
// ---------------------------------------------------------------------------
export async function seedTenantsFromDB(pool: Pool, logger?: Logger): Promise<void> {
  try {
    const result = await pool.query<{
      tenant_id: string;
      name: string;
      plan: string;
      is_active: boolean;
      features: Record<string, boolean>;
      allowed_origins: string[];
      key_hash: string;
      rate_limit: number | null;
    }>(`
      SELECT
        t.id            AS tenant_id,
        t.name,
        t.plan,
        t.is_active,
        t.features,
        t.allowed_origins,
        k.key_hash,
        NULL::int       AS rate_limit
      FROM tenant_api_keys k
      JOIN tenants t ON t.id = k.tenant_id
      WHERE k.is_active = true
        AND (k.expires_at IS NULL OR k.expires_at > NOW())
        AND t.is_active = true
    `);

    let count = 0;
    for (const row of result.rows) {
      const existing = tenantStore.get(row.tenant_id);
      // env-var entries take precedence over DB entries
      if (existing) continue;
      registerTenant({
        tenantId: row.tenant_id,
        name: row.name || row.tenant_id,
        plan: (["starter", "growth", "enterprise"].includes(row.plan) ? row.plan : "starter") as TenantConfig["plan"],
        features: (row.features as TenantConfig["features"]) ?? { avatar: false, voice: false, rag: true },
        security: {
          apiKeyHash: row.key_hash,
          hashAlgorithm: "sha256",
          allowedOrigins: row.allowed_origins ?? [],
          rateLimit: row.rate_limit ?? 100,
          rateLimitWindowMs: 60_000,
        },
        enabled: true,
      });
      count++;
    }
    logger?.info({ count }, "seedTenantsFromDB: loaded tenant API keys from DB");
  } catch (err) {
    logger?.warn({ err }, "seedTenantsFromDB: failed to load tenants from DB");
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
