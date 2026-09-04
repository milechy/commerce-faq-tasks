import { timingSafeEqual, createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import type { Pool } from "pg";
import type { TenantConfig } from "../types/contracts";
import type { AuthedRequest } from "../agent/http/authMiddleware";
import { isOriginAllowed } from "../api/middleware/originCheck";
import { pool } from "./db";
import { logger as appLogger } from "./logger";

// ---------------------------------------------------------------------------
// In-memory tenant registry (DB-backed via seedTenantsFromDB at startup)
// ---------------------------------------------------------------------------
const tenantStore = new Map<string, TenantConfig>();

// APIキーの有効期限。TenantConfig 本体には含めず、キー発行/失効時にのみ
// registerTenant と対で更新する（型 TenantConfig は他モジュール共有のため変更しない）。
const apiKeyExpiresAt = new Map<string, number | null>();

// 無停止ローテーション用の「追加キー」。TenantConfig.security.apiKeyHash は
// 引き続き単一の「主キー」を保持する（authMiddleware.ts等の既存参照を壊さない）。
// client_adminが新キーを発行しても旧キー(主キー)を即座に失効させたくない場合、
// 新キーはここに追加され、主キーと並行して有効になる。
// tenantId -> (keyHash -> expiresAtMs|null)
const additionalApiKeys = new Map<string, Map<string, number | null>>();

/**
 * 主キーを失効させずに、追加のAPIキーを有効化する（無停止ローテーション）。
 * テナントが tenantStore に存在しない場合は false を返す。
 */
export function addTenantApiKey(
  tenantId: string,
  keyHash: string,
  expiresAt: Date | null
): boolean {
  if (!tenantStore.has(tenantId)) return false;
  let keys = additionalApiKeys.get(tenantId);
  if (!keys) {
    keys = new Map<string, number | null>();
    additionalApiKeys.set(tenantId, keys);
  }
  keys.set(keyHash, expiresAt ? expiresAt.getTime() : null);
  return true;
}

/**
 * 追加キー（主キー以外）を失効させる。対象が追加キーに存在しない場合は
 * 何もせず false を返す（主キーの失効は revokeTenantApiKeyIfCurrent が担当）。
 *
 * 注意: 呼び出し側が「主キーか追加キーか」を判断する必要はない。
 * DELETE ハンドラからは必ず revokeTenantApiKey() を使うこと
 * （片方だけ呼ぶと失効漏れになる。実際に super_admin 側で発生した）。
 */
export function revokeAdditionalTenantApiKey(
  tenantId: string,
  keyHash: string
): boolean {
  const keys = additionalApiKeys.get(tenantId);
  if (!keys) return false;
  for (const existingHash of keys.keys()) {
    if (safeCompare(existingHash, keyHash)) {
      keys.delete(existingHash);
      return true;
    }
  }
  return false;
}

/**
 * テナントのAPIキーを、主キー・追加キーのどちらであっても失効させる。
 *
 * DBで is_active=false にしたキーを in-memory からも即座に落とすための
 * 単一の入口。主キー用(revokeTenantApiKeyIfCurrent)と追加キー用
 * (revokeAdditionalTenantApiKey)を個別に呼ぶ形だと、呼び出し側の一方が
 * 片方しか呼ばず「DBはinactiveなのに認証は通り続ける」fail-open を招くため
 * （super_admin の DELETE で実際に発生）、失効の呼び出し口はこの関数に統一する。
 *
 * 戻り値: in-memory 側で実際に無効化したら true。
 */
export function revokeTenantApiKey(tenantId: string, revokedKeyHash: string): boolean {
  // 両方に問い合わせる。短絡評価にすると主キーがヒットした時点で
  // 追加キー側が評価されず、同一ハッシュが両方に残る事故を見逃す。
  const revokedPrimary = revokeTenantApiKeyIfCurrent(tenantId, revokedKeyHash);
  const revokedAdditional = revokeAdditionalTenantApiKey(tenantId, revokedKeyHash);
  return revokedPrimary || revokedAdditional;
}

export function registerTenant(config: TenantConfig): void {
  tenantStore.set(config.tenantId, config);
}

/**
 * APIキー発行/更新時に有効期限を記録する。null は無期限。
 * registerTenant と同じタイミングで呼び出すこと。
 */
export function setTenantApiKeyExpiry(tenantId: string, expiresAt: Date | null): void {
  apiKeyExpiresAt.set(tenantId, expiresAt ? expiresAt.getTime() : null);
}

/**
 * キー失効（DELETE /keys/:keyId）時に、失効対象のハッシュが現在
 * in-memory に保持中のキーと一致する場合のみ、その場で無効化する。
 * PM2 再起動を待たずに反映するための即時反映処理。
 * 戻り値: in-memory 側を無効化したら true。
 */
export function revokeTenantApiKeyIfCurrent(tenantId: string, revokedKeyHash: string): boolean {
  const existing = tenantStore.get(tenantId);
  if (!existing) return false;
  if (!safeCompare(existing.security.apiKeyHash, revokedKeyHash)) return false;
  tenantStore.set(tenantId, {
    ...existing,
    security: { ...existing.security, apiKeyHash: "" },
  });
  apiKeyExpiresAt.delete(tenantId);
  return true;
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

// last_used_at のDB書き込みは認証のホットパスなので同期的に待たない。
// 毎リクエスト書き込むと負荷になるため、同一キーハッシュに対しては
// LAST_USED_DEBOUNCE_MS 以内の再書き込みをスキップする（インメモリのデバウンス
// テーブルなので、PM2再起動直後は1回分の書き込みが増えるだけで実害はない）。
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000; // 5分
const lastUsedWriteAttemptAt = new Map<string, number>();

function touchLastUsedAt(keyHash: string): void {
  if (!pool) return; // DATABASE_URL未設定（テスト環境等）では何もしない
  const now = Date.now();
  const last = lastUsedWriteAttemptAt.get(keyHash);
  if (last !== undefined && now - last < LAST_USED_DEBOUNCE_MS) return;
  lastUsedWriteAttemptAt.set(keyHash, now);
  pool
    .query(`UPDATE tenant_api_keys SET last_used_at = NOW() WHERE key_hash = $1`, [keyHash])
    .catch((err: unknown) => {
      appLogger.warn({ err }, "tenant-context: failed to update last_used_at (non-blocking)");
    });
}

export function getTenantByApiKeyHash(
  hash: string
): TenantConfig | undefined {
  const entries = Array.from(tenantStore.values());
  for (const cfg of entries) {
    if (cfg.security.apiKeyHash && safeCompare(cfg.security.apiKeyHash, hash)) {
      const expiresAt = apiKeyExpiresAt.get(cfg.tenantId);
      if (expiresAt !== undefined && expiresAt !== null && expiresAt <= Date.now()) {
        return undefined; // 稼働中に期限切れ（起動時seedはDB側でフィルタ済みだが、以降の失効を反映）
      }
      touchLastUsedAt(hash);
      return cfg;
    }
    // 無停止ローテーションで追加されたキー（主キーとは独立して有効期限を持つ）。
    // 引き続き safeCompare による定数時間比較で線形探索する（Map.getによる
    // O(1)逆引きに置き換えると、既に呼び出し側でハッシュ化済みとはいえ
    // タイミング差を持ち込むため採用しない）。
    const additional = additionalApiKeys.get(cfg.tenantId);
    if (additional) {
      for (const [additionalHash, expiresAt] of additional) {
        if (!safeCompare(additionalHash, hash)) continue;
        if (expiresAt !== null && expiresAt <= Date.now()) return undefined;
        touchLastUsedAt(hash);
        return cfg;
      }
    }
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

/**
 * Update only `security.allowedOrigins` of an existing in-memory tenant.
 * Used by PATCH /v1/admin/tenants/:id to propagate a DB change instantly,
 * so a new origin (or a removed one) takes effect without a PM2 restart.
 * Call only when the PATCH body explicitly included `allowed_origins` —
 * passing `[]` means "no origins configured" (as stored in the DB) and is
 * written as-is; the distinction between "field omitted" and "set to []"
 * must be made by the caller before invoking this function.
 * Returns true if tenant was found in store, false if not (DB-only tenant).
 */
export function updateTenantAllowedOrigins(tenantId: string, origins: string[]): boolean {
  const existing = tenantStore.get(tenantId);
  if (!existing) return false;
  tenantStore.set(tenantId, {
    ...existing,
    security: { ...existing.security, allowedOrigins: origins },
  });
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

/** seedTenantsFromDB が読むDB行の形。テストのフィクスチャ型と重複させない。 */
export type SeedTenantRow = {
  tenant_id: string;
  name: string;
  plan: string;
  is_active: boolean;
  features: Record<string, boolean>;
  allowed_origins: string[];
  key_hash: string;
  rate_limit: number | null;
  expires_at: string | null;
};

/** seedTenantsFromDB の1回分の読み取り。テナント単位にまとめたMapを返す。 */
async function fetchActiveTenantRows(pool: Pool): Promise<Map<string, SeedTenantRow[]>> {
  const result = await pool.query<SeedTenantRow>(`
    SELECT
      t.id            AS tenant_id,
      t.name,
      t.plan,
      t.is_active,
      t.features,
      t.allowed_origins,
      k.key_hash,
      k.expires_at,
      NULL::int       AS rate_limit
    FROM tenant_api_keys k
    JOIN tenants t ON t.id = k.tenant_id
    WHERE k.is_active = true
      AND (k.expires_at IS NULL OR k.expires_at > NOW())
      AND t.is_active = true
    ORDER BY t.id, k.created_at DESC, k.key_hash
  `);

  // このSELECTは「アクティブなキー1本につき1行」を返すため、N本のキーを持つ
  // テナントはN行に現れる。テナント単位にまとめてから登録する。
  const rowsByTenant = new Map<string, SeedTenantRow[]>();
  for (const row of result.rows) {
    const rows = rowsByTenant.get(row.tenant_id);
    if (rows) rows.push(row);
    else rowsByTenant.set(row.tenant_id, [row]);
  }
  return rowsByTenant;
}

// ---------------------------------------------------------------------------
// Seed from DB (tenant_api_keys + tenants JOIN) — call once at startup
// ---------------------------------------------------------------------------
/**
 * @param retryDelayMs 2回目の読み取りまでの待機時間。テストから0を渡して
 *   高速化できるようにしている（既定値はテストでの実待機を避けるため未指定時
 *   のみ実際に使われる）。
 */
export async function seedTenantsFromDB(pool: Pool, logger?: Logger, retryDelayMs = 300): Promise<void> {
  try {
    // ★二重読み取り(2026-09-04是正・GID 1218171750803663)★
    // 2026-09-04の本番デプロイで、DB側のデータは正しいのに起動直後のこの
    // クエリだけが一過性でテナントを取りこぼす事象が実測された(11回中1回、
    // 原因未特定・根本対応は別途必要)。同じクエリを短い間隔を空けてもう一度
    // 実行し、件数が少ない方ではなく多い方を採用する。一致していれば追加
    // コストはこの1クエリ+短い待機のみ(起動時に一度だけ)。
    //
    // ★既知のトレードオフ(2026-09-04レビュー是正で明記)★
    // 「多い方を採用」は、1回目と2回目の間(最大 retryDelayMs)に運用者が
    // テナントを無効化する・APIキーを失効させる等の正当な同時実行の変更が
    // 起きた場合、その変更前の(既に古いはずの)状態を「より正しい」として
    // 誤って復活させうる。この関数は起動時に一度だけ、かつ既定300msという
    // 極小の窓でしか動かないため許容しているが、窓を広げる場合はこの
    // トレードオフが拡大することに注意。件数が同数の場合はこの問題が
    // 起きないより新しい方(2回目)を優先する。
    const first = await fetchActiveTenantRows(pool);
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    // 2回目の読み取り自体は独立したtry/catchで囲む。1回目が成功した後に
    // 2回目だけが例外を投げるケース(起動直後のDB瞬断・接続競合)で、1回目の
    // 正しい結果ごと外側のcatchに握りつぶされ0テナント登録になる退行が
    // あった(2回目の読み取りを導入したこと自体が生んだ新しい欠落パターン)。
    // 2回目が失敗したら1回目の結果をそのまま使う。
    let second: Map<string, SeedTenantRow[]> | null = null;
    try {
      second = await fetchActiveTenantRows(pool);
    } catch (err) {
      logger?.warn(
        { err },
        "seedTenantsFromDB: 2回目の読み取りが失敗した。1回目の結果で復元を続ける"
      );
    }
    if (second !== null && second.size !== first.size) {
      logger?.error(
        { firstCount: first.size, secondCount: second.size },
        "seedTenantsFromDB: 2回の読み取りでテナント件数が食い違った(起動直後の一過性欠落の疑い)。多い方を採用する"
      );
    }
    const rowsByTenant = second !== null && second.size >= first.size ? second : first;

    let tenantCount = 0;
    let keyCount = 0;
    for (const [tenantId, rows] of rowsByTenant) {
      // env-var entries take precedence over DB entries.
      // seedTenantsFromEnv() が先に走るため、env で定義済みのテナントは
      // 設定もキー集合も env が唯一の情報源とみなし、DB側は一切足さない
      // （キーだけ足すと env で意図的に絞ったキー集合を DB が広げてしまう）。
      if (tenantStore.has(tenantId)) continue;

      // ORDER BY で最新キーが先頭に来る。ORDER BY が無いとPostgresの
      // 物理行順・プラン依存で「どれが主キーになるか」が再起動ごとに変わり、
      // 引退させたはずの旧キーが主キーとして復活しうる。
      const [primary, ...additional] = rows;
      if (!primary) continue;

      registerTenant({
        tenantId: primary.tenant_id,
        name: primary.name || primary.tenant_id,
        // fail-safe: 未知/null値は最も制限の強い free_ad へ倒す(starterへ「昇格」しない)。
        // 2026-08-24時点で getTenantConfig() の呼び出し元は無く(TenantConfig.plan は
        // 現状どこからも読まれていない)実害は無いが、planFeatures.ts と同じ不変条件を保つ。
        plan: (["free_ad", "starter", "standard", "growth", "enterprise"].includes(primary.plan) ? primary.plan : "free_ad") as TenantConfig["plan"],
        features: (primary.features as TenantConfig["features"]) ?? { avatar: false, voice: false, rag: true },
        security: {
          apiKeyHash: primary.key_hash,
          hashAlgorithm: "sha256",
          allowedOrigins: primary.allowed_origins ?? [],
          rateLimit: primary.rate_limit ?? 100,
          rateLimitWindowMs: 60_000,
        },
        enabled: true,
      });
      setTenantApiKeyExpiry(tenantId, primary.expires_at ? new Date(primary.expires_at) : null);

      // 残りのアクティブキーも復元する。これが無いと、client_admin が無停止
      // ローテーションで追加したキーが PM2 再起動のたびに消え、DB上は
      // is_active=true のまま認証できなくなる（ローテーション機能が
      // プロセス内でしか成立しない）。
      for (const row of additional) {
        addTenantApiKey(tenantId, row.key_hash, row.expires_at ? new Date(row.expires_at) : null);
      }

      tenantCount++;
      keyCount += rows.length;
    }
    logger?.info(
      { count: tenantCount, keyCount },
      "seedTenantsFromDB: loaded tenant API keys from DB"
    );
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
