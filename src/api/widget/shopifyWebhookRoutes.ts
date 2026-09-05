// src/api/widget/shopifyWebhookRoutes.ts
//
// Shopify Webhook 受信: app/uninstalled + GDPR 必須3種
// (customers/data_request / customers/redact / shop/redact)。
// Asana GID 1218199958286419。要件: docs/SHOPIFY_APP_REQUIREMENTS.md
// FR-14〜FR-16b, D15, D16, §12.2 X-1・X-6・X-14。
//
// HMAC検証は必ず shopifyHmac.ts の verifyShopifyWebhookHmac を通す。
// 4エンドポイントで個別に検証ロジックを実装しない(buildShopifyWebhookHandler
// が唯一の入口)。
//
// ★raw body 必須★
// verifyShopifyWebhookHmac は生バイト列に対してHMACを計算するため、この
// ファイルの4ルートは express.raw({ type: "application/json" }) を通す。
// registerShopifyWebhookRoutes(app, db) は、src/index.ts のグローバル
// app.use(express.json(...)) より「前」に呼ぶ必要がある(/v1/billing/webhook
// の Stripe Webhook と同一の理由・同一のパターン。express.json() が先に
// body を消費すると生バイト列が失われ、署名検証は必ず失敗する)。
// ★本タスクの時点では index.ts への配線は行っていない(タスク指示が
// shopifyWebhookRoutes.ts + テストの新規作成のみに限定されているため)。
// 配線(index.ts への1行追加)は統合タスクの範囲とする★
//
// ★冪等性(X-14)はベストエフォート実装★
// 新規テーブルを作らない制約(本タスクの新規ファイルは実装+テストの2つのみ)
// のため、stripeWebhook.ts の stripe_webhook_events のようなDB永続の claim
// テーブルは導入していない。プロセス内メモリの Map で
// `${topic}:${shopDomain}:${eventId}` をキーに二重処理を防ぐのみであり、
// プロセス再起動・複数インスタンス運用では効かない。永続化した冪等キー管理は
// 別タスクの範囲とする。
//
// ★customers/redact は本タスクではスタブ実装★
// Shopify の customer(id/email/phone)から R2C 側の chat_sessions.visitor_id
// への相関を取る列が存在しない(visitorDataRepository.ts の削除は
// tenant_id + visitor_id スコープが前提で、Shopify customer との対応表が
// 無い)ため、対象の会話データを自動特定して DELETE することはできない。
// 「対象を特定できなかった」事実を audit_logs に記録するに留める。実データの
// 相関付け・削除の実装は別タスクの範囲とする(D15)。

import express from "express";
import type { Express, Request, Response } from "express";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { logger } from "../../lib/logger";
import { verifyShopifyWebhookHmac } from "./shopifyHmac";
import {
  findTenantByShopDomain,
  markDeletionRequested,
  type ShopifyTenantRow,
} from "./shopifyRepository";

// ---------------------------------------------------------------------------
// 冪等性ガード(プロセス内メモリ、ベストエフォート。ファイル冒頭コメント参照)
// ---------------------------------------------------------------------------
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h。Shopifyのリトライ窓を十分にカバーする

const seenWebhookEvents = new Map<string, number>();

function isDuplicateWebhookEvent(key: string): boolean {
  const now = Date.now();
  // 期限切れエントリを都度掃除する(メモリリーク防止。TTLを超えたキーは
  // 「別イベント」として扱って構わない = Shopifyのリトライは通常これより短い)。
  for (const [existingKey, seenAt] of seenWebhookEvents) {
    if (now - seenAt > IDEMPOTENCY_TTL_MS) {
      seenWebhookEvents.delete(existingKey);
    }
  }
  if (seenWebhookEvents.has(key)) {
    return true;
  }
  seenWebhookEvents.set(key, now);
  return false;
}

/** テスト専用: モジュール状態(冪等性キャッシュ)をリセットする。 */
export function _resetShopifyWebhookIdempotencyCacheForTest(): void {
  seenWebhookEvents.clear();
}

// ---------------------------------------------------------------------------
// 共通の検証・パース
// ---------------------------------------------------------------------------
function toRawBodyString(req: Request): string {
  const body = req.body as unknown;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  // express.raw({ type: "application/json" }) を通していない、または
  // Content-Type が一致しないリクエストはここに来る。HMAC対象のバイト列と
  // 一致しえないため、後続の署名検証で必ず失敗させる(fail-closed)。
  return JSON.stringify(body ?? {});
}

interface VerifiedShopifyWebhook {
  shopDomain: string;
  eventId: string;
  payload: unknown;
}

/**
 * HMAC検証 → JSONパース → 冪等キー抽出をまとめて行う。
 * 検証失敗時は401を、パース失敗時は400を自分でセットして null を返す
 * (呼び出し側は null なら即 return するだけでよい)。
 */
function verifyAndParseShopifyWebhook(
  req: Request,
  res: Response,
  topic: string
): VerifiedShopifyWebhook | null {
  const rawBody = toRawBodyString(req);
  const hmacHeader = req.header("X-Shopify-Hmac-Sha256");
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!verifyShopifyWebhookHmac({ rawBody, hmacHeader, secret })) {
    logger.warn({ topic }, "[shopify webhook] HMAC検証に失敗、拒否");
    res.status(401).json({ error: "invalid_hmac", message: "Webhook署名の検証に失敗しました。" });
    return null;
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    res.status(400).json({ error: "invalid_payload", message: "リクエスト本文をJSONとして解釈できませんでした。" });
    return null;
  }

  const shopDomain = req.header("X-Shopify-Shop-Domain") ?? "";
  // X-Shopify-Webhook-Id はShopifyが配信ごとに付与する一意ID(推奨の冪等キー)。
  // 欠落する古い形式のテスト・環境向けに、本文ハッシュへフォールバックする
  // (同一本文の再送は同一キーになる。本文が配信ごとに変わるトピックは無い)。
  const explicitEventId = req.header("X-Shopify-Webhook-Id");
  const eventId =
    explicitEventId && explicitEventId.length > 0
      ? explicitEventId
      : `body:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;

  return { shopDomain, eventId, payload };
}

interface ShopifyCustomer {
  id?: number | string;
  email?: string;
  phone?: string;
}

interface ShopifyWebhookHandlerArgs {
  db: Pool;
  tenant: ShopifyTenantRow;
  shopDomain: string;
  payload: unknown;
  res: Response;
}

/**
 * 4エンドポイント共通の骨格。HMAC検証 → 冪等チェック → db可用性 → テナント解決
 * まで行い、トピック固有の処理は handle コールバックへ委譲する。
 */
function buildShopifyWebhookHandler(
  topic: string,
  db: Pool | null,
  handle: (args: ShopifyWebhookHandlerArgs) => Promise<void>
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const verified = verifyAndParseShopifyWebhook(req, res, topic);
    if (!verified) return; // 401 or 400 は verifyAndParseShopifyWebhook 内で送信済み

    const { shopDomain, eventId, payload } = verified;

    if (isDuplicateWebhookEvent(`${topic}:${shopDomain}:${eventId}`)) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    if (!db) {
      res.status(503).json({ error: "service_unavailable", message: "現在この機能は利用できません。" });
      return;
    }

    try {
      const tenant = await findTenantByShopDomain(db, shopDomain);
      if (!tenant) {
        // 既に接続解除済み/未接続のshopからの到達は正常系として扱う
        // (見つからないことを理由にShopifyへ再送させない = 再送地獄の回避)。
        logger.warn({ shopDomain, topic }, "[shopify webhook] 対応するテナントが見つからない");
        res.status(200).json({ received: true, tenant_found: false });
        return;
      }
      await handle({ db, tenant, shopDomain, payload, res });
    } catch (err) {
      logger.error({ err, shopDomain, topic }, "[shopify webhook] 処理に失敗");
      if (!res.headersSent) {
        res.status(500).json({ error: "handler_error", message: "処理に失敗しました。" });
      }
    }
  };
}

/**
 * customers/redact のスタブ実装: 対象を自動削除せず、audit_logs に「削除request
 * を受けたが自動特定できなかった」事実を記録する(D15、ファイル冒頭コメント参照)。
 * audit_logs は既存の右消去(Right to Erasure)機構が使う汎用監査テーブル
 * (deleteSessionRepository.ts / visitorDataRepository.ts と同じテーブル)。
 *
 * 生のメール・電話番号はメタデータに残さない(CLAUDE.md Anti-Slop: PIIを
 * ログ・メタデータに書き残さない方針を踏襲。存在有無のフラグのみ残す)。
 * 監査記録の失敗はWebhook応答(200)を壊さない(fire-and-forget、
 * agentAuditLog.ts と同じ try/catch + logger.warn の型)。
 */
async function recordCustomerRedactRequest(
  db: Pool,
  tenantId: string,
  shopDomain: string,
  customer: ShopifyCustomer | undefined
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_logs (tenant_id, action, actor_role, actor_email, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        "shopify_customers_redact_requested",
        "system",
        "",
        "shopify_customer",
        customer?.id !== undefined ? String(customer.id) : "unknown",
        JSON.stringify({
          shop_domain: shopDomain,
          has_email: Boolean(customer?.email),
          has_phone: Boolean(customer?.phone),
          note:
            "スタブ実装: Shopify顧客とchat_sessions.visitor_idを相関付ける手段が無いため、" +
            "対象の会話データを自動特定・削除していない。実データの削除は別タスクの範囲。",
        }),
      ]
    );
  } catch (err) {
    logger.warn({ err, tenantId }, "[shopify webhook] customers/redact 監査ログ記録に失敗");
  }
}

export function registerShopifyWebhookRoutes(app: Express, db: Pool | null): void {
  const rawBodyParser = express.raw({ type: "application/json", limit: "1mb" });

  // ---------------------------------------------------------------------------
  // POST /v1/public/shopify/webhooks/app-uninstalled (FR-04)
  // ウィジェットの新規表示のみ止める。テナント自体・会話データは削除しない。
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/public/shopify/webhooks/app-uninstalled",
    rawBodyParser,
    buildShopifyWebhookHandler("app/uninstalled", db, async ({ db: pool, tenant, res }) => {
      await pool.query(`UPDATE tenants SET is_active = false WHERE id = $1`, [tenant.id]);
      res.status(200).json({ received: true });
    })
  );

  // ---------------------------------------------------------------------------
  // POST /v1/public/shopify/webhooks/customers-data-request (FR-16b)
  // 削除は伴わない。保持しているデータの種別をJSONで自動応答する。
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/public/shopify/webhooks/customers-data-request",
    rawBodyParser,
    buildShopifyWebhookHandler(
      "customers/data_request",
      db,
      async ({ shopDomain, payload, res }) => {
        const customer = (payload as { customer?: ShopifyCustomer } | null)?.customer;
        res.status(200).json({
          received: true,
          shop_domain: shopDomain,
          customer_id: customer?.id ?? null,
          generated_at: new Date().toISOString(),
          data_categories: [
            { table: "chat_sessions", description: "ウィジェット経由の会話セッション(開始時刻・訪問者ID等)" },
            { table: "chat_messages", description: "会話内のメッセージ本文" },
            { table: "option_orders", description: "会話に紐づく注文情報(あれば)" },
          ],
          note:
            "Shopify顧客IDと当該テナントの会話データ(visitor_id)を機械的に相関付ける手段が" +
            "現状無いため、個別の会話内容そのものはこのレスポンスに含めていません。" +
            "特定の会話の開示が必要な場合は運用者による手動照合が必要です。",
        });
      }
    )
  );

  // ---------------------------------------------------------------------------
  // POST /v1/public/shopify/webhooks/customers-redact (FR-16a, D15スタブ)
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/public/shopify/webhooks/customers-redact",
    rawBodyParser,
    buildShopifyWebhookHandler(
      "customers/redact",
      db,
      async ({ db: pool, tenant, shopDomain, payload, res }) => {
        const customer = (payload as { customer?: ShopifyCustomer } | null)?.customer;
        await recordCustomerRedactRequest(pool, tenant.id, shopDomain, customer);
        res.status(200).json({ received: true });
      }
    )
  );

  // ---------------------------------------------------------------------------
  // POST /v1/public/shopify/webhooks/shop-redact (FR-16, D15)
  // 削除保留としてマークするのみ。実データは削除しない(人間承認後に別タスクで実行)。
  // ---------------------------------------------------------------------------
  app.post(
    "/v1/public/shopify/webhooks/shop-redact",
    rawBodyParser,
    buildShopifyWebhookHandler("shop/redact", db, async ({ db: pool, tenant, res }) => {
      await markDeletionRequested(pool, tenant.id);
      res.status(200).json({ received: true, deletion_requested: true });
    })
  );
}
