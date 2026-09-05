// src/api/widget/shopifySettingsRoutes.test.ts
//
// Shopify連携(docs/SHOPIFY_APP_REQUIREMENTS.md) FR-06〜FR-08: 表示面選択・表示位置の
// 設定同期API。wpSettingsRoutes.test.ts と同じ流儀(認証→GET→PATCH、境界値、
// DB未接続/存在しない/DBエラーの各分岐)でカバーする。
//
// 固定する不変条件:
//   FR-06 面選択(product_page/cart/shipping_policy)は既存TriggerEngineの
//         page_url_match にマッピングされ、GETレスポンスの triggers に反映される
//   FR-07 オフセットは0〜320pxの範囲外・非数値を400で拒否する(丸めない)
//   FR-08/D9 保存できたように見せて実際は保存されていない、を作らない
//         → PATCHの検証エラーはDBに一切触れず、成功時は更新後の全体設定を返す
//   禁止20 存在しない(shop domain不一致)と空(surfaces未設定)を同じ値で表現しない

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { registerShopifySettingsRoutes, SHOPIFY_SURFACES } from "./shopifySettingsRoutes";

// wpSettingsRoutes.test.ts と同じ理由(モジュール単位のレート制限storeが
// テスト間でリセットされない)で無効化する。
jest.mock("../../lib/rate-limit", () => ({
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  registerShopifySettingsRoutes(app, db);
  return app;
}

const SHOP_DOMAIN = "example.myshopify.com";
const TENANT_ID = "tenant-1";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("認証(GET/PATCH共通)", () => {
  it("db未接続なら503", async () => {
    const appGet = makeApp(null);
    const resGet = await request(appGet)
      .get("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID);
    expect(resGet.status).toBe(503);

    const appPatch = makeApp(null);
    const resPatch = await request(appPatch)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ position: "bottom-left" });
    expect(resPatch.status).toBe(503);
  });

  it("x-shopify-shop-domainヘッダが無ければ401(DBに触れない)", async () => {
    const dbQuery = jest.fn();
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/shopify/settings").set("x-tenant-id", TENANT_ID);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_shop_domain");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("x-tenant-idヘッダが無ければ401(DBに触れない)", async () => {
    const dbQuery = jest.fn();
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/shopify/settings").set("x-shopify-shop-domain", SHOP_DOMAIN);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_tenant_id");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("shopドメインとテナントIDの組み合わせが一致しなければ401で、存在有無を漏らさない", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .get("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", "other-tenant");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("shop_domain_mismatch");
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("WHERE shopify_shop_domain = $1 AND id = $2");
    expect(params).toEqual([SHOP_DOMAIN, "other-tenant"]);
  });
});

describe("GET /v1/public/shopify/settings", () => {
  it("widget_theme未設定時は既定値・全surface falseを返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 }) // 認証
      .mockResolvedValueOnce({
        rows: [{ plan: "starter", is_active: true, widget_theme: {} }],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .get("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tenant_id: TENANT_ID,
      plan: "starter",
      is_active: true,
      position: "bottom-right",
      offset_x: 24,
      offset_y: 24,
      surfaces: { product_page: false, cart: false, shipping_policy: false },
      triggers: [],
    });
  });

  it("surfaces設定済みならtriggersに既存TriggerEngineのpage_url_matchとしてマッピングされる", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            plan: "growth",
            is_active: true,
            widget_theme: {
              position: "bottom-left",
              offsetX: 96,
              offsetY: 40,
              shopifySurfaceProductPage: true,
              shopifySurfaceCart: false,
              shopifySurfaceShippingPolicy: true,
            },
          },
        ],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .get("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID);

    expect(res.status).toBe(200);
    expect(res.body.position).toBe("bottom-left");
    expect(res.body.offset_x).toBe(96);
    expect(res.body.offset_y).toBe(40);
    expect(res.body.surfaces).toEqual({ product_page: true, cart: false, shipping_policy: true });
    expect(res.body.triggers).toEqual([
      { trigger_type: "page_url_match", trigger_config: { patterns: ["/products/*"], match_type: "glob" } },
      {
        trigger_type: "page_url_match",
        trigger_config: { patterns: ["/policies/shipping-policy"], match_type: "glob" },
      },
    ]);
  });

  it("不正な形式のpositionが直接DBに入っていた場合は既定値として扱う(直接DB操作への防御)", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ plan: "starter", is_active: true, widget_theme: { position: "top-center" } }],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .get("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID);
    expect(res.status).toBe(200);
    expect(res.body.position).toBe("bottom-right");
  });

  it("テナントが見つからない場合は404", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .get("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID);
    expect(res.status).toBe(404);
  });

  it("DBエラー時は500", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockRejectedValueOnce(new Error("db down"));
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .get("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("settings_fetch_failed");
  });
});

describe("PATCH /v1/public/shopify/settings", () => {
  it("フィールド未指定は400(DBに触れない)", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_fields");
    expect(dbQuery).toHaveBeenCalledTimes(1); // 認証クエリのみ
  });

  it("surfacesが空オブジェクトのみの場合も400(DBに触れない)", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ surfaces: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_fields");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("surfacesに未知のキーを送ると400(strictスキーマ、DBに触れない)", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ surfaces: { checkout_page: true } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["positionが不正な値", { position: "top-left" }],
    ["offset_xが-1(範囲外)", { offset_x: -1 }],
    ["offset_xが321(範囲外)", { offset_x: 321 }],
    ["offset_yが数値でも数字文字列でもない", { offset_y: "abc" }],
  ])("%s は400でDB更新に触れない(認証クエリのみ)", async (_label, body) => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send(body);
    expect(res.status).toBe(400);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["offset_xが0(境界内)", { offset_x: 0 }],
    ["offset_xが320(境界内)", { offset_x: 320 }],
  ])("%s は許可される", async (_label, body) => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ plan: "starter", is_active: true, widget_theme: { offsetX: (body as any).offset_x } }],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.offset_x).toBe((body as any).offset_x);
  });

  it("surfaces更新は正しいSQLパラメータでUPDATEし、更新後の全体設定を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 }) // 認証
      .mockResolvedValueOnce({
        rows: [
          {
            plan: "starter",
            is_active: true,
            widget_theme: { shopifySurfaceCart: true },
          },
        ],
        rowCount: 1,
      }); // UPDATE
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ surfaces: { cart: true } });

    expect(res.status).toBe(200);
    expect(res.body.surfaces).toEqual({ product_page: false, cart: true, shipping_policy: false });
    expect(res.body.triggers).toEqual([
      { trigger_type: "page_url_match", trigger_config: { patterns: ["/cart"], match_type: "glob" } },
    ]);

    const [sql, params] = dbQuery.mock.calls[1];
    expect(sql).toContain("widget_theme = COALESCE(widget_theme, '{}') || $1::jsonb");
    expect(sql).toContain("UPDATE tenants");
    expect(sql).toContain("RETURNING plan, is_active, widget_theme");
    expect(JSON.parse(params[0] as string)).toEqual({ shopifySurfaceCart: true });
    expect(params[1]).toBe(TENANT_ID);
  });

  it("複数surfaceを個別にPATCHしても他のsurfaceの値を消さない(浅いマージの安全性)", async () => {
    // 1回目: cartをtrueに設定
    const dbQuery1 = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ plan: "starter", is_active: true, widget_theme: { shopifySurfaceCart: true } }],
        rowCount: 1,
      });
    const app1 = makeApp({ query: dbQuery1 });
    await request(app1)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ surfaces: { cart: true } });

    // 2回目: product_pageをtrueに設定(既存のcart=trueは維持されている想定を
    // DB側のCOALESCE(...) || $1::jsonbの浅いマージが担保する。ここではPATCH実装が
    // cart以外のキーをthemePatchに含めないことだけを確認する)
    const dbQuery2 = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            plan: "starter",
            is_active: true,
            widget_theme: { shopifySurfaceCart: true, shopifySurfaceProductPage: true },
          },
        ],
        rowCount: 1,
      });
    const app2 = makeApp({ query: dbQuery2 });
    const res2 = await request(app2)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ surfaces: { product_page: true } });

    expect(res2.status).toBe(200);
    const [, params2] = dbQuery2.mock.calls[1];
    // product_page以外のキー(cart)を巻き込んでいないこと(部分更新)
    expect(JSON.parse(params2[0] as string)).toEqual({ shopifySurfaceProductPage: true });
    expect(res2.body.surfaces).toEqual({ product_page: true, cart: true, shipping_policy: false });
  });

  it("position/offset更新は正しいSQLパラメータでUPDATEし、更新後の全体設定を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            plan: "starter",
            is_active: true,
            widget_theme: { position: "bottom-left", offsetX: 96, offsetY: 24 },
          },
        ],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ position: "bottom-left", offset_x: 96 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tenant_id: TENANT_ID,
      plan: "starter",
      is_active: true,
      position: "bottom-left",
      offset_x: 96,
      offset_y: 24,
      surfaces: { product_page: false, cart: false, shipping_policy: false },
      triggers: [],
    });

    const [, params] = dbQuery.mock.calls[1];
    expect(JSON.parse(params[0] as string)).toEqual({ position: "bottom-left", offsetX: 96 });
    expect(params[1]).toBe(TENANT_ID);
  });

  it("テナントが見つからない場合は404", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ position: "bottom-left" });
    expect(res.status).toBe(404);
  });

  it("DBエラー時は500", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: TENANT_ID }], rowCount: 1 })
      .mockRejectedValueOnce(new Error("db down"));
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/shopify/settings")
      .set("x-shopify-shop-domain", SHOP_DOMAIN)
      .set("x-tenant-id", TENANT_ID)
      .send({ position: "bottom-left" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("settings_update_failed");
  });
});

describe("SHOPIFY_SURFACES", () => {
  it("3つの既知の面(商品ページ/カート/配送ポリシー)を定義している", () => {
    expect(SHOPIFY_SURFACES).toEqual(["product_page", "cart", "shipping_policy"]);
  });
});
