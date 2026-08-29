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

/**
 * `defaultAllowedOrigins` が空(=ALLOWED_ORIGINS env未設定)のとき、development/test では
 * 全オリジンを許可する「dev wildcard mode」を維持する。ただしこれを production にまで
 * 適用すると、env設定漏れが「テナント登録の有無に関わらず全オリジン許可+
 * Access-Control-Allow-Credentials:true」という fail-open になる
 * (isKnownTenantOrigin によるテナント単位の絞り込みごと迂回されるため)。
 * securityLayerConfig.ts と同じ考え方で、known でない環境は「本番かもしれない」側に倒す
 * (fail-safe)。
 */
const DEV_WILDCARD_ENVS = new Set(["development", "test"]);

function isDevWildcardModeActive(): boolean {
  return DEV_WILDCARD_ENVS.has(process.env["NODE_ENV"] ?? "");
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// X-Request-ID の受信は許可のまま（上流LB/クライアントのトレース相関用途）。
// ただしサーバは受信値を課金・識別には使わない（request-id.ts が req.requestId を
// 必ずサーバ新規採番し、受信値は clientTraceId としてログ相関のみに使う）。
// レスポンスの X-Request-ID はサーバ採番の正規IDを返す（EXPOSED_HEADERS）。
const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "X-Tenant-ID",
  "X-Request-ID",
  "X-R2C-Traffic-Source",
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

  if (allowedSet.size === 0 && !isDevWildcardModeActive()) {
    opts.logger?.warn(
      "[cors] ALLOWED_ORIGINS が未設定です。テナント登録済みのオリジンのみ許可します" +
        "（isKnownTenantOrigin）。意図した設定か確認してください。"
    );
  }

  return function corsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const origin = req.headers.origin;

    const isAllowed =
      !!origin &&
      (allowedSet.has(origin) ||
        (opts.isKnownTenantOrigin?.(origin) ?? false) ||
        (allowedSet.size === 0 && isDevWildcardModeActive()));

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
