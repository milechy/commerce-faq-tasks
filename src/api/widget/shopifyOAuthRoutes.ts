// src/api/widget/shopifyOAuthRoutes.ts
//
// Shopify アプリの OAuth インストール・コールバック(Asana 1218199958286066)。
// 要件: docs/SHOPIFY_APP_REQUIREMENTS.md FR-01〜FR-03, D16
//
// ★スコープ★
// このファイルが担うのは「インストール開始 → 認可コード交換 → テナント紐付け」
// までであり、Shopify Billing 連携(D19: 課金未承認でチャットを稼働させない)は
// 別タスクで既存 src/lib/billing/suspensionGate.ts に接続する(ここでは行わない)。
// 同様に、ウィジェットが実際に使う認証情報(既存 tenant_api_keys)の発行も
// このファイルの責務ではない(要件の制約: 「新しいAPIキー体系を作らない」)。
// Shopify のアクセストークンは shopify_access_token_encrypted に保存するだけで、
// tenant_api_keys とは完全に別物(C-3: このトークンで /v1/admin/* は叩けない)。
//
// ★OAuth state(CSRF対策)の設計★
// wp_provisionings のようなDBテーブルを新設せず(このタスクの制約: 新規ファイルは
// 実装+テストの2つのみ)、自己完結型の署名付きトークンにする。
// shop・nonce・発行時刻(iat)を JSON 化して base64url し、Shopify の Client Secret
// (SHOPIFY_API_SECRET、この app が Shopify との OAuth に使う秘密値そのもの)で
// HMAC-SHA256 署名する。用途タグ(OAUTH_STATE_PURPOSE)を署名対象に含めることで、
// 同じ secret の別用途(将来追加されうる Webhook HMAC 等)との署名の使い回しを防ぐ。
// wpProvisionToken.ts の「ランダム値+サーバ側にハッシュを保存する」方式と違い、
// サーバ側に何も保持しない(state は往復するだけで検証は署名検証のみで完結する)。
//
// ★HMAC 検証の対象について★
// Shopify のコールバック要求自体(クエリパラメータ)の HMAC(query legitimacy check)は
// このタスクのスコープに含めない。認可コード(code)は Shopify にしか発行できず、
// 偽造した code ではトークン交換(exchangeShopifyAccessToken)が必ず失敗するため、
// state の検証と合わせて実質的な CSRF/なりすまし対策になっている。
// Webhook 本文の HMAC 検証は既存 shopifyHmac.ts(verifyShopifyWebhookHmac、
// base64・生ボディ)が別プロトコルとして担う(このファイルでは使わない)。
//
// db は引数で受け取る。内部で getPool() を呼ばない(CLAUDE.md: tenantHasFeature が
// 踏んだのと同じ穴を避ける)。

import type { Express, NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import crypto from "node:crypto";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { createRateLimitMiddleware } from "../../lib/rate-limit";
import { encryptText } from "../../lib/crypto/textEncrypt";
import { registerTenant } from "../../lib/tenant-context";
import {
  findTenantByShopDomain,
  linkTenantToShop,
  markProvisioningSource,
  clearDeletionPending,
} from "./shopifyRepository";

// ---------------------------------------------------------------------------
// 設定値の取得(遅延読み込み — テストで process.env を切り替えられるようにする。
// textEncrypt.ts の plaintextFallbackAllowed() と同じ「都度読む」方針)
// ---------------------------------------------------------------------------
function getShopifyApiKey(): string | undefined {
  return process.env.SHOPIFY_API_KEY || undefined;
}
function getShopifyApiSecret(): string | undefined {
  return process.env.SHOPIFY_API_SECRET || undefined;
}
function getShopifyScopes(): string {
  // v1 はテキストチャット(FAQ/RAG)のみで商品データ自動同期は行わない(D4)。
  // Billing API 自体は追加スコープを要求しないため、既定値は最小限に留める。
  return process.env.SHOPIFY_SCOPES || "read_products";
}
function getApiBaseUrl(): string {
  return process.env.API_BASE_URL || "https://api.r2c.biz";
}

function getShopifyCallbackUrl(): string {
  return `${getApiBaseUrl().replace(/\/$/, "")}/v1/public/shopify/callback`;
}

// ---------------------------------------------------------------------------
// shop ドメインの検証
// ---------------------------------------------------------------------------
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** `shop` クエリパラメータを検証・正規化する。不正なら null。 */
function normalizeShopDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (lower.length === 0 || lower.length > 100) return null;
  if (!SHOP_DOMAIN_RE.test(lower)) return null;
  return lower;
}

// ---------------------------------------------------------------------------
// OAuth state(CSRF対策トークン、自己完結・署名検証のみ・サーバ側に状態を持たない)
// ---------------------------------------------------------------------------
const OAUTH_STATE_PURPOSE = "shopify_oauth_state_v1";
/** 接続ボタンを押してから認可画面で承認するまでの猶予。長すぎる窓を作らない。 */
export const SHOPIFY_OAUTH_STATE_TTL_MINUTES = 10;

interface OAuthStatePayload {
  shop: string;
  nonce: string;
  iat: number;
}

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Buffer {
  const restored = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (restored.length % 4)) % 4;
  return Buffer.from(restored + "=".repeat(padLength), "base64");
}

function signOAuthStatePayload(payloadB64: string, secret: string): string {
  return base64UrlEncode(
    crypto.createHmac("sha256", secret).update(`${OAUTH_STATE_PURPOSE}.${payloadB64}`).digest()
  );
}

/** OAuth state トークンを発行する。純粋関数(現在時刻は呼び出し側から受ける)。 */
export function createShopifyOAuthState(shop: string, secret: string, now: Date): string {
  const payload: OAuthStatePayload = {
    shop,
    nonce: crypto.randomBytes(16).toString("hex"),
    iat: now.getTime(),
  };
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${signOAuthStatePayload(payloadB64, secret)}`;
}

export type ShopifyOAuthStateResult =
  | { ok: true; shop: string }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * OAuth state を検証する。純粋関数。
 * 署名不一致・形式不正 → "invalid"、TTL 超過 → "expired"(禁止20: 区別する)。
 */
export function verifyShopifyOAuthState(
  state: unknown,
  secret: string,
  now: Date,
  ttlMinutes: number
): ShopifyOAuthStateResult {
  if (typeof state !== "string" || state.length === 0 || state.length > 4000) {
    return { ok: false, reason: "invalid" };
  }
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [payloadB64, sig] = parts;

  const expectedSig = signOAuthStatePayload(payloadB64, secret);
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  const providedBuf = Buffer.from(sig, "utf8");
  if (expectedBuf.length !== providedBuf.length) return { ok: false, reason: "invalid" };

  let sigMatches: boolean;
  try {
    sigMatches = crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    sigMatches = false;
  }
  if (!sigMatches) return { ok: false, reason: "invalid" };

  let payload: Partial<OAuthStatePayload>;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof payload.shop !== "string" || typeof payload.iat !== "number") {
    return { ok: false, reason: "invalid" };
  }

  const elapsedMs = now.getTime() - payload.iat;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { ok: false, reason: "invalid" };
  }
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 0 || elapsedMs >= ttlMinutes * 60_000) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, shop: payload.shop };
}

// ---------------------------------------------------------------------------
// 認可コード ⇄ アクセストークン交換
// ---------------------------------------------------------------------------
export interface ShopifyAccessTokenResult {
  accessToken: string;
  scope: string;
}

/**
 * Shopify の /admin/oauth/access_token に認可コードを渡し、アクセストークンと
 * 実際に付与されたスコープを取得する。テストでは global.fetch をモックする。
 */
async function exchangeShopifyAccessToken(
  shop: string,
  code: string,
  apiKey: string,
  apiSecret: string
): Promise<ShopifyAccessTokenResult> {
  const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });
  if (!resp.ok) {
    throw new Error(`shopify token exchange failed with status ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token?: unknown; scope?: unknown };
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("shopify token exchange response missing access_token");
  }
  return {
    accessToken: data.access_token,
    scope: typeof data.scope === "string" ? data.scope : "",
  };
}

// ---------------------------------------------------------------------------
// テナント解決(FR-02/FR-03/D16)
// ---------------------------------------------------------------------------
/**
 * shop ドメインの先頭ラベルから tenants.id を組み立てる(createTenantSchema の
 * `^[a-z0-9_-]+$` に必ず収まる)。wpSiteUrl.ts の buildWpTenantId と同じ考え方だが
 * プレフィックスが異なるため、この用途専用に小さく持つ(3行の重複は早すぎる
 * 抽象化より良い — implementation.md)。
 */
function buildShopifyTenantId(shopDomain: string, randomSuffix: string): string {
  const firstLabel = shopDomain.split(".")[0] ?? "";
  const sanitized = firstLabel
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  const base = sanitized.length > 0 ? sanitized : "shop";
  const suffix =
    randomSuffix
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16) || "0";
  return `shopify-${base}-${suffix}`;
}

async function createShopifyTenant(db: Pool, shop: string): Promise<string> {
  const tenantId = buildShopifyTenantId(shop, crypto.randomBytes(4).toString("hex"));
  await db.query(
    `INSERT INTO tenants (id, name, plan, is_active, provisioning_source)
     VALUES ($1, $2, 'starter', true, 'shopify_app')`,
    [tenantId, shop]
  );

  // in-memory storeにも同期(既存の認証フローとの互換性、POST /v1/admin/tenants と同じ理由)。
  // apiKeyHash は空のまま — Shopify 経由テナントの widget 認証情報の発行はこのファイルの
  // 責務ではない(要件の制約)。/api/chat はこの時点ではまだ通らない。
  registerTenant({
    tenantId,
    name: shop,
    plan: "starter",
    features: { avatar: false, voice: false, rag: true },
    security: {
      apiKeyHash: "",
      hashAlgorithm: "sha256",
      allowedOrigins: [],
      rateLimit: 100,
      rateLimitWindowMs: 60_000,
    },
    enabled: true,
  });

  return tenantId;
}

/**
 * shop ドメインからテナントを解決する。
 *   - 既存テナントがあり削除未承認(deletion_approved_at IS NULL) → そのテナントへ接続
 *     (削除保留中(deletion_requested_at 設定済み)なら D16 に従い保留を解除して復元する)
 *   - 既存テナントが無い、または削除承認済み(deletion_approved_at 設定済み) → 新規作成
 *     (D16後段: 承認後の再インストールは新規テナントとして扱う)
 */
async function resolveTenantForShop(db: Pool, shop: string): Promise<string> {
  const existing = await findTenantByShopDomain(db, shop);
  if (existing && existing.deletion_approved_at === null) {
    if (existing.deletion_requested_at !== null) {
      await clearDeletionPending(db, existing.id);
    }
    return existing.id;
  }
  return createShopifyTenant(db, shop);
}

// ---------------------------------------------------------------------------
// レート制限(未認証ルートなので ip 段のみ、CLAUDE.md 禁止28)
// ---------------------------------------------------------------------------
const SHOPIFY_OAUTH_IP_LIMIT = 20;
const shopifyOAuthRateLimiter = createRateLimitMiddleware({
  stage: "ip",
  getLimit: () => SHOPIFY_OAUTH_IP_LIMIT,
});

// ---------------------------------------------------------------------------
// クエリバリデーション
// ---------------------------------------------------------------------------
const installQuerySchema = z.object({
  shop: z.string().min(1).max(100),
});

const callbackQuerySchema = z.object({
  shop: z.string().min(1).max(100),
  code: z.string().min(1).max(500),
  state: z.string().min(1).max(4000),
});

export function registerShopifyOAuthRoutes(app: Express, db: Pool | null): void {
  function requireConfigured(_req: Request, res: Response, next: NextFunction): void {
    if (!db) {
      res.status(503).json({ error: "service_unavailable", message: "現在この機能は利用できません。" });
      return;
    }
    if (!getShopifyApiKey() || !getShopifyApiSecret()) {
      logger.warn("[shopify-oauth] SHOPIFY_API_KEY/SHOPIFY_API_SECRET is not configured");
      res.status(503).json({ error: "service_unavailable", message: "現在この機能は利用できません。" });
      return;
    }
    next();
  }

  // -------------------------------------------------------------------------
  // GET /v1/public/shopify/install — OAuth 開始
  // -------------------------------------------------------------------------
  app.get(
    "/v1/public/shopify/install",
    shopifyOAuthRateLimiter,
    requireConfigured,
    (req: Request, res: Response) => {
      const parsed = installQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
        return;
      }
      const shop = normalizeShopDomain(parsed.data.shop);
      if (!shop) {
        res.status(400).json({
          error: "invalid_shop",
          message: "shopパラメータの形式が正しくありません（例: your-store.myshopify.com）。",
        });
        return;
      }

      const apiKey = getShopifyApiKey() as string;
      const apiSecret = getShopifyApiSecret() as string;
      const state = createShopifyOAuthState(shop, apiSecret, new Date());

      const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", apiKey);
      authorizeUrl.searchParams.set("scope", getShopifyScopes());
      authorizeUrl.searchParams.set("redirect_uri", getShopifyCallbackUrl());
      authorizeUrl.searchParams.set("state", state);

      res.redirect(authorizeUrl.toString());
    }
  );

  // -------------------------------------------------------------------------
  // GET /v1/public/shopify/callback — OAuth コールバック
  // -------------------------------------------------------------------------
  app.get(
    "/v1/public/shopify/callback",
    shopifyOAuthRateLimiter,
    requireConfigured,
    async (req: Request, res: Response) => {
      const parsed = callbackQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
        return;
      }

      const shop = normalizeShopDomain(parsed.data.shop);
      if (!shop) {
        res.status(400).json({
          error: "invalid_shop",
          message: "shopパラメータの形式が正しくありません。",
        });
        return;
      }

      const apiSecret = getShopifyApiSecret() as string;
      const stateResult = verifyShopifyOAuthState(
        parsed.data.state,
        apiSecret,
        new Date(),
        SHOPIFY_OAUTH_STATE_TTL_MINUTES
      );
      if (!stateResult.ok) {
        const expired = stateResult.reason === "expired";
        res.status(401).json({
          error: expired ? "state_expired" : "state_invalid",
          message: expired
            ? "認証セッションの有効期限が切れました。もう一度アプリのインストールをやり直してください。"
            : "認証情報を確認できませんでした。もう一度アプリのインストールをやり直してください。",
        });
        return;
      }
      // state に埋め込まれた shop と、Shopify から実際に返ってきた shop が一致しない場合は
      // 拒否する(CSRF token の使い回し・別ストアへの誤結合を防ぐ)。
      if (stateResult.shop !== shop) {
        res.status(401).json({
          error: "state_invalid",
          message: "認証情報を確認できませんでした。もう一度アプリのインストールをやり直してください。",
        });
        return;
      }

      try {
        const apiKey = getShopifyApiKey() as string;
        const tokenResult = await exchangeShopifyAccessToken(
          shop,
          parsed.data.code,
          apiKey,
          apiSecret
        );

        const tenantId = await resolveTenantForShop(db as Pool, shop);
        const encryptedToken = encryptText(tokenResult.accessToken);
        await linkTenantToShop(db as Pool, tenantId, shop, encryptedToken, tokenResult.scope);
        await markProvisioningSource(db as Pool, tenantId, "shopify_app");

        // 成功後は Shopify Admin 内のアプリ画面へ戻す(公式に推奨される復帰先)。
        // 埋め込み管理画面(shopify-app/)の実装は別タスクのスコープ。
        res.redirect(`https://${shop}/admin/apps/${apiKey}`);
      } catch (err) {
        logger.warn({ err, shop }, "[GET /v1/public/shopify/callback]");
        res.status(500).json({
          error: "install_failed",
          message: "インストール処理に失敗しました。しばらくしてから再度お試しください。",
        });
      }
    }
  );
}
