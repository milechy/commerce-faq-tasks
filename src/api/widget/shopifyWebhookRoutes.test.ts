// src/api/widget/shopifyWebhookRoutes.test.ts
//
// 固定する不変条件(docs/SHOPIFY_APP_REQUIREMENTS.md):
//   X-1   HMAC検証に失敗したWebhookは401で拒否し、ペイロードを処理しない
//   X-14  同一イベントの複数回配信(Shopifyのリトライ)で二重処理しない(冪等キー)
//   D15   customers/data_request(自動応答・削除なし) /
//         customers/redact(単一顧客スコープの記録) /
//         shop/redact(削除保留マークのみ・実削除は人間承認後の別タスク) の
//         破壊力に応じた分岐
//   FR-04 app/uninstalled はウィジェットの新規表示のみ止め、テナント・会話データは
//         削除しない
//
// 冪等性はプロセス内メモリのベストエフォート実装(ファイル冒頭コメント参照)。
// モジュール状態が積み上がらないよう、各テストの前に
// _resetShopifyWebhookIdempotencyCacheForTest() でリセットする。

import express from "express";
import { createHmac } from "node:crypto";
import { request } from "../../../tests/helpers/testServer";
import {
  registerShopifyWebhookRoutes,
  _resetShopifyWebhookIdempotencyCacheForTest,
} from "./shopifyWebhookRoutes";

const SECRET = "test-shopify-webhook-secret";
const SHOP_DOMAIN = "example.myshopify.com";

const DEFAULT_TENANT = {
  id: "tenant-a",
  shopify_shop_domain: SHOP_DOMAIN,
  shopify_scope: "read_products",
  shopify_installed_at: new Date("2026-09-01T00:00:00Z"),
  provisioning_source: "shopify_app",
  deletion_requested_at: null,
  deletion_approved_at: null,
  deletion_approved_by: null,
};

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

/** パターンマッチ式のDBモック(stripeWebhook.test.ts / shopifyRepository.test.ts と同じ流儀)。 */
function makeDb(overrides: Record<string, (sql: string, params: unknown[]) => unknown> = {}) {
  const merged: Record<string, (sql: string, params: unknown[]) => unknown> = {
    "FROM tenants WHERE shopify_shop_domain = $1": () => ({ rows: [DEFAULT_TENANT], rowCount: 1 }),
    "UPDATE tenants SET is_active = false": () => ({ rows: [], rowCount: 1 }),
    "INSERT INTO audit_logs": () => ({ rows: [], rowCount: 1 }),
    "SET deletion_requested_at = NOW()": () => ({ rows: [], rowCount: 1 }),
    ...overrides,
  };
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    for (const [pattern, handler] of Object.entries(merged)) {
      if (norm.includes(pattern)) return handler(norm, params);
    }
    throw new Error(`unexpected query: ${norm}`);
  });
  return { query } as any;
}

function makeApp(db: unknown) {
  const app = express();
  // ★グローバル express.json() を挟まない★ 本番の index.ts でも
  // registerShopifyWebhookRoutes は express.json() より前に登録する契約
  // (raw body が必要なため。ファイル冒頭コメント参照)。テストでもその前提を再現する。
  registerShopifyWebhookRoutes(app as any, db as any);
  return app;
}

interface PostOpts {
  shopDomain?: string;
  webhookId?: string;
  hmac?: string;
}

function postWebhook(app: unknown, path: string, bodyObj: unknown, opts: PostOpts = {}) {
  const body = JSON.stringify(bodyObj);
  const hmac = opts.hmac ?? sign(body);
  const req = request(app)
    .post(path)
    .set("Content-Type", "application/json")
    .set("X-Shopify-Hmac-Sha256", hmac);
  if (opts.shopDomain !== undefined) req.set("X-Shopify-Shop-Domain", opts.shopDomain);
  if (opts.webhookId !== undefined) req.set("X-Shopify-Webhook-Id", opts.webhookId);
  return req.send(body);
}

beforeEach(() => {
  _resetShopifyWebhookIdempotencyCacheForTest();
  process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.SHOPIFY_WEBHOOK_SECRET;
});

describe("HMAC検証(X-1: 全4ルート共通)", () => {
  const routes = [
    "/v1/public/shopify/webhooks/app-uninstalled",
    "/v1/public/shopify/webhooks/customers-data-request",
    "/v1/public/shopify/webhooks/customers-redact",
    "/v1/public/shopify/webhooks/shop-redact",
  ];

  it.each(routes)("%s: 署名不一致は401で拒否しペイロードを処理しない", async (path) => {
    const db = makeDb();
    const app = makeApp(db);

    const res = await postWebhook(app, path, { shop_domain: SHOP_DOMAIN }, { shopDomain: SHOP_DOMAIN, hmac: "invalid-signature==" });

    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each(routes)("%s: secret未設定はfail-closedで401", async (path) => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    const db = makeDb();
    const app = makeApp(db);

    const res = await postWebhook(app, path, { shop_domain: SHOP_DOMAIN }, { shopDomain: SHOP_DOMAIN });

    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("POST /v1/public/shopify/webhooks/app-uninstalled (FR-04)", () => {
  const PATH = "/v1/public/shopify/webhooks/app-uninstalled";

  it("正常系: ウィジェットの新規表示のみ止める(is_active=false)。テナント行は削除しない", async () => {
    const db = makeDb();
    const app = makeApp(db);

    const res = await postWebhook(app, PATH, { domain: SHOP_DOMAIN }, { shopDomain: SHOP_DOMAIN, webhookId: "evt-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const calls = db.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((sql: string) => sql.includes("UPDATE tenants SET is_active = false"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("DELETE"))).toBe(false);
  });

  it("対応するテナントが見つからない場合は200(再送させない)で、更新は行わない", async () => {
    const db = makeDb({ "FROM tenants WHERE shopify_shop_domain = $1": () => ({ rows: [], rowCount: 0 }) });
    const app = makeApp(db);

    const res = await postWebhook(app, PATH, { domain: "unknown.myshopify.com" }, { shopDomain: "unknown.myshopify.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, tenant_found: false });
  });

  it("db未接続時は503", async () => {
    const app = makeApp(null);
    const res = await postWebhook(app, PATH, { domain: SHOP_DOMAIN }, { shopDomain: SHOP_DOMAIN });
    expect(res.status).toBe(503);
  });
});

describe("POST /v1/public/shopify/webhooks/customers-data-request (FR-16b)", () => {
  const PATH = "/v1/public/shopify/webhooks/customers-data-request";

  it("正常系: 削除を伴わず、保持データの一覧をJSONで自動応答する", async () => {
    const db = makeDb();
    const app = makeApp(db);

    const res = await postWebhook(
      app,
      PATH,
      { shop_domain: SHOP_DOMAIN, customer: { id: 191167, email: "john@example.com" } },
      { shopDomain: SHOP_DOMAIN }
    );

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.customer_id).toBe(191167);
    expect(Array.isArray(res.body.data_categories)).toBe(true);
    expect(res.body.data_categories.length).toBeGreaterThan(0);
    // 削除系のクエリは一切発行しない(findTenantByShopDomainのSELECTのみ)
    const calls = db.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.every((sql: string) => sql.trim().startsWith("SELECT"))).toBe(true);
  });
});

describe("POST /v1/public/shopify/webhooks/customers-redact (FR-16a, D15スタブ)", () => {
  const PATH = "/v1/public/shopify/webhooks/customers-redact";

  it("正常系: 対象顧客の識別情報を監査ログ(audit_logs)に記録し、生のPIIは残さない", async () => {
    const db = makeDb();
    const app = makeApp(db);

    const res = await postWebhook(
      app,
      PATH,
      { shop_domain: SHOP_DOMAIN, customer: { id: 191167, email: "john@example.com", phone: "555-0100" } },
      { shopDomain: SHOP_DOMAIN }
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const auditCall = db.query.mock.calls.find((c: unknown[]) => String(c[0]).includes("INSERT INTO audit_logs"));
    expect(auditCall).toBeDefined();
    const [, params] = auditCall as [string, unknown[]];
    expect(params[0]).toBe(DEFAULT_TENANT.id); // tenant_id
    expect(params[1]).toBe("shopify_customers_redact_requested"); // action
    expect(params[5]).toBe("191167"); // target_id = shopify customer id
    const metadata = JSON.parse(params[6] as string);
    expect(metadata.has_email).toBe(true);
    expect(metadata.has_phone).toBe(true);
    // 生のメール・電話番号はメタデータに残さない
    expect(JSON.stringify(metadata)).not.toContain("john@example.com");
    expect(JSON.stringify(metadata)).not.toContain("555-0100");
  });

  it("監査ログ記録が失敗してもWebhook応答は200(fire-and-forget)", async () => {
    const db = makeDb({
      "INSERT INTO audit_logs": () => {
        throw new Error("db down");
      },
    });
    const app = makeApp(db);

    const res = await postWebhook(app, PATH, { shop_domain: SHOP_DOMAIN, customer: { id: 1 } }, { shopDomain: SHOP_DOMAIN });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/public/shopify/webhooks/shop-redact (FR-16, D15)", () => {
  const PATH = "/v1/public/shopify/webhooks/shop-redact";

  it("正常系: markDeletionRequested相当のUPDATEで削除保留にマークするのみ。実データは削除しない", async () => {
    const db = makeDb();
    const app = makeApp(db);

    const res = await postWebhook(app, PATH, { shop_domain: SHOP_DOMAIN }, { shopDomain: SHOP_DOMAIN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, deletion_requested: true });
    const calls = db.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((sql: string) => sql.includes("SET deletion_requested_at = NOW()"))).toBe(true);
    expect(calls.some((sql: string) => sql.includes("DELETE"))).toBe(false);
  });
});

describe("冪等性(X-14): 同一イベントの複数回配信で二重処理しない", () => {
  it("同一 X-Shopify-Webhook-Id の再送は2回目以降 duplicate:true を返し、副作用を再実行しない", async () => {
    const db = makeDb();
    const app = makeApp(db);
    const path = "/v1/public/shopify/webhooks/shop-redact";
    const opts = { shopDomain: SHOP_DOMAIN, webhookId: "evt-dup-001" };

    const first = await postWebhook(app, path, { shop_domain: SHOP_DOMAIN }, opts);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, deletion_requested: true });

    const second = await postWebhook(app, path, { shop_domain: SHOP_DOMAIN }, opts);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    // 削除保留の実UPDATEは1回だけ発行されている(2回目は冪等キャッシュでスキップ)
    const updateCalls = db.query.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("SET deletion_requested_at = NOW()")
    );
    expect(updateCalls).toHaveLength(1);
  });

  it("X-Shopify-Webhook-Id欠落時は本文ハッシュへフォールバックし、同一本文の再送も二重処理しない", async () => {
    const db = makeDb();
    const app = makeApp(db);
    const path = "/v1/public/shopify/webhooks/app-uninstalled";
    const bodyObj = { domain: SHOP_DOMAIN };

    const first = await postWebhook(app, path, bodyObj, { shopDomain: SHOP_DOMAIN });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });

    const second = await postWebhook(app, path, bodyObj, { shopDomain: SHOP_DOMAIN });
    expect(second.body).toEqual({ received: true, duplicate: true });

    const updateCalls = db.query.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("UPDATE tenants SET is_active = false")
    );
    expect(updateCalls).toHaveLength(1);
  });

  it("異なる X-Shopify-Webhook-Id は別イベントとして通常どおり処理する", async () => {
    const db = makeDb();
    const app = makeApp(db);
    const path = "/v1/public/shopify/webhooks/shop-redact";

    const first = await postWebhook(app, path, { shop_domain: SHOP_DOMAIN }, { shopDomain: SHOP_DOMAIN, webhookId: "evt-a" });
    const second = await postWebhook(app, path, { shop_domain: SHOP_DOMAIN }, { shopDomain: SHOP_DOMAIN, webhookId: "evt-b" });

    expect(first.body).toEqual({ received: true, deletion_requested: true });
    expect(second.body).toEqual({ received: true, deletion_requested: true });

    const updateCalls = db.query.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("SET deletion_requested_at = NOW()")
    );
    expect(updateCalls).toHaveLength(2);
  });
});
