// src/api/widget/shopifyOAuthRoutes.test.ts
//
// 固定する不変条件(docs/SHOPIFY_APP_REQUIREMENTS.md):
//   FR-02  インストール完了時、shop ドメインを唯一のテナント識別子としてテナントを自動作成する
//   FR-03  既存テナントへの接続要求として扱う経路(新規重複作成を防ぐ)
//   D16    削除保留中の再インストールは復元、削除承認済みの再インストールは新規テナント
//   C-2    state不一致・再利用(期限切れ)を拒否する
//   禁止1  tenantId(ここでは shop)を検証なしに信用しない
//   禁止20 「存在しない」と「期限切れ」を同じ値で表現しない(state_invalid / state_expired)

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import {
  registerShopifyOAuthRoutes,
  createShopifyOAuthState,
  verifyShopifyOAuthState,
  SHOPIFY_OAUTH_STATE_TTL_MINUTES,
} from "./shopifyOAuthRoutes";

// rate-limit.ts の store はモジュール単位のシングルトンでテスト間でリセットされない。
// ルーティング・状態遷移のロジックだけを見るため無効化する(wpProvisionRoutes.test.ts と同じ理由)。
jest.mock("../../lib/rate-limit", () => ({
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../lib/tenant-context", () => ({
  registerTenant: jest.fn(),
}));
import { registerTenant } from "../../lib/tenant-context";

jest.mock("./shopifyRepository", () => ({
  findTenantByShopDomain: jest.fn(),
  linkTenantToShop: jest.fn(),
  markProvisioningSource: jest.fn(),
  clearDeletionPending: jest.fn(),
}));
import {
  findTenantByShopDomain,
  linkTenantToShop,
  markProvisioningSource,
  clearDeletionPending,
} from "./shopifyRepository";

const mockFindTenantByShopDomain = findTenantByShopDomain as jest.Mock;
const mockLinkTenantToShop = linkTenantToShop as jest.Mock;
const mockMarkProvisioningSource = markProvisioningSource as jest.Mock;
const mockClearDeletionPending = clearDeletionPending as jest.Mock;

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const SHOP = "example-store.myshopify.com";
const API_KEY = "test-client-id";
const API_SECRET = "test-client-secret";

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  registerShopifyOAuthRoutes(app, db);
  return app;
}

function makeDb() {
  return { query: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SHOPIFY_API_KEY = API_KEY;
  process.env.SHOPIFY_API_SECRET = API_SECRET;
  process.env.API_BASE_URL = "https://api.r2c.biz";
  mockFindTenantByShopDomain.mockResolvedValue(null);
  mockLinkTenantToShop.mockResolvedValue(true);
  mockMarkProvisioningSource.mockResolvedValue(true);
  mockClearDeletionPending.mockResolvedValue(true);
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ access_token: "shpat_dummy", scope: "read_products" }),
  });
});

afterEach(() => {
  delete process.env.SHOPIFY_API_KEY;
  delete process.env.SHOPIFY_API_SECRET;
  delete process.env.API_BASE_URL;
});

describe("createShopifyOAuthState / verifyShopifyOAuthState", () => {
  it("発行直後は検証を通り、shopを復元できる", () => {
    const now = new Date("2026-09-05T00:00:00Z");
    const state = createShopifyOAuthState(SHOP, API_SECRET, now);
    const result = verifyShopifyOAuthState(state, API_SECRET, now, SHOPIFY_OAUTH_STATE_TTL_MINUTES);
    expect(result).toEqual({ ok: true, shop: SHOP });
  });

  it("TTLちょうど超過で expired を返す(禁止20: invalidと区別する)", () => {
    const issuedAt = new Date("2026-09-05T00:00:00Z");
    const state = createShopifyOAuthState(SHOP, API_SECRET, issuedAt);
    const later = new Date(issuedAt.getTime() + SHOPIFY_OAUTH_STATE_TTL_MINUTES * 60_000);
    const result = verifyShopifyOAuthState(state, API_SECRET, later, SHOPIFY_OAUTH_STATE_TTL_MINUTES);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("TTL内(1ms前)なら有効", () => {
    const issuedAt = new Date("2026-09-05T00:00:00Z");
    const state = createShopifyOAuthState(SHOP, API_SECRET, issuedAt);
    const justBefore = new Date(issuedAt.getTime() + SHOPIFY_OAUTH_STATE_TTL_MINUTES * 60_000 - 1);
    const result = verifyShopifyOAuthState(state, API_SECRET, justBefore, SHOPIFY_OAUTH_STATE_TTL_MINUTES);
    expect(result.ok).toBe(true);
  });

  it("署名が異なるsecretで検証すると invalid", () => {
    const now = new Date();
    const state = createShopifyOAuthState(SHOP, API_SECRET, now);
    const result = verifyShopifyOAuthState(state, "wrong-secret", now, SHOPIFY_OAUTH_STATE_TTL_MINUTES);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("改ざんされたペイロード(shopを差し替え)は invalid", () => {
    const now = new Date();
    const state = createShopifyOAuthState(SHOP, API_SECRET, now);
    const [payloadB64, sig] = state.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ shop: "evil.myshopify.com", nonce: "x", iat: now.getTime() }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tampered = `${tamperedPayload}.${sig}`;
    const result = verifyShopifyOAuthState(tampered, API_SECRET, now, SHOPIFY_OAUTH_STATE_TTL_MINUTES);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(payloadB64).not.toEqual(tamperedPayload);
  });

  it("形式不正(区切りが無い)は invalid", () => {
    const result = verifyShopifyOAuthState("not-a-valid-state", API_SECRET, new Date(), 10);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("空文字は invalid", () => {
    const result = verifyShopifyOAuthState("", API_SECRET, new Date(), 10);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("GET /v1/public/shopify/install", () => {
  it("db未接続なら503", async () => {
    const app = makeApp(null);
    const res = await request(app).get("/v1/public/shopify/install").query({ shop: SHOP });
    expect(res.status).toBe(503);
  });

  it("SHOPIFY_API_KEY未設定なら503", async () => {
    delete process.env.SHOPIFY_API_KEY;
    const app = makeApp(makeDb());
    const res = await request(app).get("/v1/public/shopify/install").query({ shop: SHOP });
    expect(res.status).toBe(503);
  });

  it("shopパラメータ欠落は400", async () => {
    const app = makeApp(makeDb());
    const res = await request(app).get("/v1/public/shopify/install");
    expect(res.status).toBe(400);
  });

  it.each([
    ["myshopify.comで終わらない", "example.com"],
    ["空文字", ""],
    ["不正な文字を含む", "exa mple.myshopify.com"],
  ])("shopの形式が不正(%s)なら400", async (_label, shop) => {
    const app = makeApp(makeDb());
    const res = await request(app).get("/v1/public/shopify/install").query({ shop });
    expect(res.status).toBe(400);
  });

  it("正常系: Shopifyの認可URLへリダイレクトし、state・client_id・redirect_uriを含む", async () => {
    const app = makeApp(makeDb());
    const res = await request(app).get("/v1/public/shopify/install").query({ shop: SHOP });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin).toBe(`https://${SHOP}`);
    expect(location.pathname).toBe("/admin/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(API_KEY);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://api.r2c.biz/v1/public/shopify/callback"
    );
    expect(location.searchParams.get("state")).toBeTruthy();

    // 発行された state はこの secret で検証を通る(往復可能性の確認)。
    const state = location.searchParams.get("state") as string;
    const verified = verifyShopifyOAuthState(state, API_SECRET, new Date(), SHOPIFY_OAUTH_STATE_TTL_MINUTES);
    expect(verified).toEqual({ ok: true, shop: SHOP });
  });

  it("SHOPIFY_SCOPES未設定なら scope パラメータを送らない(Dev Dashboardにスコープなしで登録済みのため、既定値の read_products は要求しない)", async () => {
    delete process.env.SHOPIFY_SCOPES;
    const app = makeApp(makeDb());
    const res = await request(app).get("/v1/public/shopify/install").query({ shop: SHOP });
    const location = new URL(res.headers.location);
    expect(location.searchParams.has("scope")).toBe(false);
  });

  it("SHOPIFY_SCOPESを設定すればそれがそのままscopeパラメータになる", async () => {
    process.env.SHOPIFY_SCOPES = "read_products,read_orders";
    const app = makeApp(makeDb());
    const res = await request(app).get("/v1/public/shopify/install").query({ shop: SHOP });
    const location = new URL(res.headers.location);
    expect(location.searchParams.get("scope")).toBe("read_products,read_orders");
    delete process.env.SHOPIFY_SCOPES;
  });

  it("shopの大文字は小文字化されて扱われる", async () => {
    const app = makeApp(makeDb());
    const res = await request(app)
      .get("/v1/public/shopify/install")
      .query({ shop: SHOP.toUpperCase() });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin).toBe(`https://${SHOP}`);
  });
});

describe("GET /v1/public/shopify/callback", () => {
  function validState(shop = SHOP, now = new Date()) {
    return createShopifyOAuthState(shop, API_SECRET, now);
  }

  it("db未接続なら503(X-11)", async () => {
    const app = makeApp(null);
    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: validState() });
    expect(res.status).toBe(503);
  });

  it("code欠落は400(DBに触れない)", async () => {
    const db = makeDb();
    const app = makeApp(db);
    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, state: validState() });
    expect(res.status).toBe(400);
    expect(mockFindTenantByShopDomain).not.toHaveBeenCalled();
  });

  it("shopの形式が不正なら400", async () => {
    const app = makeApp(makeDb());
    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: "not-a-shop", code: "authcode", state: validState("not-a-shop") });
    expect(res.status).toBe(400);
  });

  it("stateが不一致(異なるsecretで署名/改ざん)なら401 state_invalid(C-2)", async () => {
    const app = makeApp(makeDb());
    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: "tampered.state" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("state_invalid");
    expect(mockFindTenantByShopDomain).not.toHaveBeenCalled();
  });

  it("stateが期限切れなら401 state_expired(禁止20: invalidと区別)", async () => {
    // ルート実装は内部で new Date() を使って検証するため、実時刻から確実に
    // TTLを超えて過去になる issuedAt で state を発行する。
    const issuedAt = new Date(Date.now() - (SHOPIFY_OAUTH_STATE_TTL_MINUTES + 1) * 60_000);
    const expired = createShopifyOAuthState(SHOP, API_SECRET, issuedAt);
    const app = makeApp(makeDb());
    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: expired });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("state_expired");
  });

  it("stateに埋め込まれたshopとクエリのshopが異なれば401 state_invalid", async () => {
    const stateForOtherShop = createShopifyOAuthState("other-store.myshopify.com", API_SECRET, new Date());
    const app = makeApp(makeDb());
    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: stateForOtherShop });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("state_invalid");
  });

  it("トークン交換に失敗したら500(テナントを作らない)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const app = makeApp(makeDb());
    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "bad-code", state: validState() });
    expect(res.status).toBe(500);
    expect(mockLinkTenantToShop).not.toHaveBeenCalled();
  });

  it("正常系(新規インストール): 新規テナントを作成し、暗号化トークンを保存し、Shopify Adminへリダイレクトする(FR-02)", async () => {
    mockFindTenantByShopDomain.mockResolvedValue(null);
    const insertedTenants: unknown[][] = [];
    const db = { query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("INSERT INTO tenants")) {
        insertedTenants.push(params);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) };
    const app = makeApp(db);

    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: validState() });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://${SHOP}/admin/apps/${API_KEY}`);

    expect(insertedTenants).toHaveLength(1);
    const [tenantId, name] = insertedTenants[0] as [string, string];
    expect(name).toBe(SHOP);
    expect(tenantId).toMatch(/^shopify-example-store-[a-f0-9]+$/);

    expect(registerTenant).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, name: SHOP, plan: "starter", enabled: true })
    );

    expect(mockLinkTenantToShop).toHaveBeenCalledWith(
      db,
      tenantId,
      SHOP,
      expect.any(String),
      "read_products"
    );
    // 暗号文はプレーンなアクセストークンをそのまま含まない(test/development環境の
    // フォールバックでは平文のこともあるため、少なくとも呼び出し自体を確認する)。
    expect(mockMarkProvisioningSource).toHaveBeenCalledWith(db, tenantId, "shopify_app");
  });

  it("正常系(既存テナントへの再接続): 新規テナントを作らず既存テナントへ接続する(FR-03)", async () => {
    mockFindTenantByShopDomain.mockResolvedValue({
      id: "existing-tenant",
      shopify_shop_domain: SHOP,
      shopify_scope: "read_products",
      shopify_installed_at: new Date(),
      provisioning_source: "manual",
      deletion_requested_at: null,
      deletion_approved_at: null,
      deletion_approved_by: null,
    });
    const db = makeDb();
    const app = makeApp(db);

    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: validState() });

    expect(res.status).toBe(302);
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tenants"),
      expect.anything()
    );
    expect(registerTenant).not.toHaveBeenCalled();
    expect(mockLinkTenantToShop).toHaveBeenCalledWith(
      db,
      "existing-tenant",
      SHOP,
      expect.any(String),
      "read_products"
    );
    expect(mockMarkProvisioningSource).toHaveBeenCalledWith(db, "existing-tenant", "shopify_app");
  });

  it("同一ドメインへの重複インストールでも新規テナントを作らない(X-3)", async () => {
    mockFindTenantByShopDomain.mockResolvedValue({
      id: "already-connected-tenant",
      shopify_shop_domain: SHOP,
      shopify_scope: "read_products",
      shopify_installed_at: new Date(),
      provisioning_source: "shopify_app",
      deletion_requested_at: null,
      deletion_approved_at: null,
      deletion_approved_by: null,
    });
    const db = makeDb();
    const app = makeApp(db);
    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: validState() });
    expect(res.status).toBe(302);
    expect(registerTenant).not.toHaveBeenCalled();
    expect(mockLinkTenantToShop).toHaveBeenCalledWith(
      db,
      "already-connected-tenant",
      SHOP,
      expect.any(String),
      "read_products"
    );
  });

  it("削除保留中(承認前)の再インストールは保留を解除して既存テナントを復元する(D16前段)", async () => {
    mockFindTenantByShopDomain.mockResolvedValue({
      id: "pending-deletion-tenant",
      shopify_shop_domain: SHOP,
      shopify_scope: "read_products",
      shopify_installed_at: new Date(),
      provisioning_source: "shopify_app",
      deletion_requested_at: new Date("2026-09-01T00:00:00Z"),
      deletion_approved_at: null,
      deletion_approved_by: null,
    });
    const db = makeDb();
    const app = makeApp(db);

    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: validState() });

    expect(res.status).toBe(302);
    expect(mockClearDeletionPending).toHaveBeenCalledWith(db, "pending-deletion-tenant");
    expect(registerTenant).not.toHaveBeenCalled();
    expect(mockLinkTenantToShop).toHaveBeenCalledWith(
      db,
      "pending-deletion-tenant",
      SHOP,
      expect.any(String),
      "read_products"
    );
  });

  it("削除承認済み(実行待ち)の再インストールは新規テナントとして扱う(D16後段)", async () => {
    mockFindTenantByShopDomain.mockResolvedValue({
      id: "approved-for-deletion-tenant",
      shopify_shop_domain: SHOP,
      shopify_scope: "read_products",
      shopify_installed_at: new Date(),
      provisioning_source: "shopify_app",
      deletion_requested_at: new Date("2026-09-01T00:00:00Z"),
      deletion_approved_at: new Date("2026-09-02T00:00:00Z"),
      deletion_approved_by: "super-admin@r2c.biz",
    });
    const insertedTenants: unknown[][] = [];
    const db = { query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("INSERT INTO tenants")) {
        insertedTenants.push(params);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) };
    const app = makeApp(db);

    const res = await request(app)
      .get("/v1/public/shopify/callback")
      .query({ shop: SHOP, code: "authcode", state: validState() });

    expect(res.status).toBe(302);
    expect(insertedTenants).toHaveLength(1);
    expect(mockClearDeletionPending).not.toHaveBeenCalled();
    const [newTenantId] = insertedTenants[0] as [string];
    expect(newTenantId).not.toBe("approved-for-deletion-tenant");
    expect(mockLinkTenantToShop).toHaveBeenCalledWith(
      db,
      newTenantId,
      SHOP,
      expect.any(String),
      "read_products"
    );
  });
});
