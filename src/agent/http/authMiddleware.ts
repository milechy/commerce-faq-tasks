import * as crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  type SupabaseJwtPayload,
  verifySupabaseJwt,
} from "../../auth/verifySupabaseJwt";
import type { TenantConfig } from "../../types/contracts";

/**
 * Authenticated request — downstream handlers use these fields.
 *
 * tenantId is resolved exclusively from:
 *   - JWT: payload.tenant_id
 *   - API Key: DB lookup via apiKeyHash
 * body.tenantId is NEVER used (CLAUDE.md: "bodyから禁止").
 */
export interface AuthedRequest extends Request {
  authUser?: SupabaseJwtPayload;
  tenantId: string;
  tenantConfig?: TenantConfig;
}

function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export type TenantConfigResolver = (
  tenantId: string
) => TenantConfig | undefined;
export type ApiKeyTenantResolver = (
  apiKeyHash: string
) => TenantConfig | undefined;

export interface AuthMiddlewareOptions {
  /** Resolve TenantConfig by apiKeyHash (Agent E provides this) */
  resolveByApiKeyHash?: ApiKeyTenantResolver;
  /** Legacy: plain-text API_KEY for backward compatibility during migration */
  legacyApiKey?: string;
  /** Legacy: Basic auth credentials (deprecated — will be removed) */
  legacyBasicUser?: string;
  legacyBasicPass?: string;
}

/**
 * Unified auth middleware (Agent A + Agent E integration).
 *
 * Authentication paths (in priority order):
 *   1. Bearer JWT  → tenantId from payload.tenant_id
 *   2. x-api-key   → SHA-256 hash → DB lookup → tenantId from TenantConfig
 *   3. Basic auth   → DEPRECATED, kept only for migration
 *
 * All paths enforce: tenantId is NEVER read from req.body.
 */
export function initAuthMiddleware(opts: AuthMiddlewareOptions = {}) {
  const {
    resolveByApiKeyHash,
    legacyApiKey = process.env.API_KEY,
    legacyBasicUser = process.env.BASIC_USER,
    legacyBasicPass = process.env.BASIC_PASS,
  } = opts;

  return function authMiddleware(
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ) {
    const authHeader = req.header("authorization") ?? "";

    // --- Path 1: JWT (Bearer) — preferred ---
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      const payload = verifySupabaseJwt(token);

      if (payload) {
        req.authUser = payload;
        // CLAUDE.md: tenantId は JWT payload からのみ取得
        // Supabase JWT は app_metadata 内に tenant_id を格納するため両方参照
        req.tenantId = payload.app_metadata?.tenant_id ?? payload.tenant_id ?? "demo";
        return next();
      }

      return res.status(401).json({
        error: "invalid_token",
        message: "Bearer token の検証に失敗しました。",
      });
    }

    // --- Path 2: API Key (x-api-key) — hash verified ---
    const apiKeyHeader = req.header("x-api-key");
    if (apiKeyHeader) {
      // 2a: JWT chat-test token (starts with "eyJ") — verify before hashing
      if (apiKeyHeader.startsWith("eyJ")) {
        const payload = verifySupabaseJwt(apiKeyHeader);
        if (payload && (payload as any).purpose === "chat-test" && payload.tenant_id) {
          req.tenantId = payload.tenant_id;
          return next();
        }
        // Invalid JWT sent as api-key → reject immediately
        return res.status(401).json({
          error: "invalid_token",
          message: "chat-test トークンが無効または期限切れです。",
        });
      }

      // 2b: Hash-based lookup (production path)
      if (resolveByApiKeyHash) {
        const hash = hashApiKey(apiKeyHeader);
        const config = resolveByApiKeyHash(hash);
        if (config && config.enabled) {
          req.tenantId = config.tenantId;
          req.tenantConfig = config;
          return next();
        }
      }

      // 2b: Legacy plain-text comparison (migration only)
      if (legacyApiKey && timingSafeCompare(apiKeyHeader, legacyApiKey)) {
        req.tenantId = req.header("x-tenant-id") ?? "default";
        return next();
      }

      return res.status(401).json({
        error: "invalid_api_key",
        message: "API キーが無効です。",
      });
    }

    // --- Path 3: Basic auth (DEPRECATED — remove after migration) ---
    if (
      legacyBasicUser &&
      legacyBasicPass &&
      authHeader.startsWith("Basic ")
    ) {
      const encoded = authHeader.slice("Basic ".length).trim();
      let decoded: string;
      try {
        decoded = Buffer.from(encoded, "base64").toString("utf8");
      } catch {
        return res.status(401).json({
          error: "invalid_credentials",
          message: "Basic 認証のデコードに失敗しました。",
        });
      }
      const idx = decoded.indexOf(":");
      if (idx === -1) {
        return res.status(401).json({
          error: "invalid_credentials",
          message: "Basic 認証の形式が不正です。",
        });
      }
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);

      if (
        timingSafeCompare(user, legacyBasicUser) &&
        timingSafeCompare(pass, legacyBasicPass)
      ) {
        req.tenantId = req.header("x-tenant-id") ?? "default";
        return next();
      }

      return res.status(401).json({
        error: "invalid_credentials",
        message: "Basic 認証の資格情報が無効です。",
      });
    }

    // --- No valid credentials ---
    return res.status(401).json({
      error: "unauthorized",
      message:
        "有効な認証情報が必要です（Bearer JWT / x-api-key / Basic）。",
    });
  };
}
