// src/api/widget/wpSettingsRoutes.test.ts
//
// WP-13(docs/WORDPRESS_PLUGIN_REQUIREMENTS.md D9/§13.2): 設定の読み書きAPI。
//   FR-21 位置・除外ページ・許可ドメインの唯一の真実はR2C側DB
//   FR-24 保存できたように見せて実際は保存されていない、を作らない
//         → PATCHの検証エラーはDBに一切触れず、成功時は更新後の全体設定を返す

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { registerWpSettingsRoutes } from "./wpSettingsRoutes";
import { hashApiKey } from "../admin/tenants/apiKeyUtils";

// wpProvisionRoutes.test.ts と同じ理由(モジュール単位のレート制限storeが
// テスト間でリセットされず、このファイル単体でも上限に達しうるため)で無効化する。
jest.mock("../../lib/rate-limit", () => ({
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../lib/tenant-context", () => ({
  updateTenantAllowedOrigins: jest.fn(),
}));
import { updateTenantAllowedOrigins } from "../../lib/tenant-context";

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  registerWpSettingsRoutes(app, db);
  return app;
}

const VALID_KEY = "rjc_validkey";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("認証(GET/PATCH共通)", () => {
  it("db未接続なら503", async () => {
    const appGet = makeApp(null);
    const resGet = await request(appGet).get("/v1/public/wp/settings").set("x-api-key", VALID_KEY);
    expect(resGet.status).toBe(503);

    const appPatch = makeApp(null);
    const resPatch = await request(appPatch)
      .patch("/v1/public/wp/settings")
      .set("x-api-key", VALID_KEY)
      .send({ position: "bottom-left" });
    expect(resPatch.status).toBe(503);
  });

  it("x-api-keyヘッダが無ければ401(DBに触れない)", async () => {
    const dbQuery = jest.fn();
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/wp/settings");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("無効なキー(該当行なし)は401で、キーの存在有無を漏らさない", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/wp/settings").set("x-api-key", "rjc_invalid");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });

  it("失効済みキー(is_active=false)は照合SQLの条件により該当行なし→401", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/wp/settings").set("x-api-key", "rjc_revoked");
    expect(res.status).toBe(401);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("is_active = true");
    expect(params[0]).toBe(hashApiKey("rjc_revoked"));
  });
});

describe("GET /v1/public/wp/settings", () => {
  it("widget_theme未設定時は既定値を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 }) // 認証
      .mockResolvedValueOnce({
        rows: [{ plan: "starter", is_active: true, widget_theme: {}, allowed_origins: [], excluded_page_patterns: [] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ published_count: "0" }], rowCount: 1 }); // FAQ有無
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/wp/settings").set("x-api-key", VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tenant_id: "tenant-1",
      plan: "starter",
      is_active: true,
      has_published_faq: false,
      position: "bottom-right",
      offset_x: 24,
      offset_y: 24,
      primary_color: null,
      excluded_page_patterns: [],
      allowed_origins: [],
    });
  });

  it("widget_theme/allowed_origins/excluded_page_patterns設定済みならその値を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            plan: "growth",
            is_active: true,
            widget_theme: { position: "bottom-left", offsetX: 96, offsetY: 40, primaryColor: "#3B82F6" },
            allowed_origins: ["https://example.com"],
            excluded_page_patterns: ["/cart", "/checkout/*"],
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ published_count: "3" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/wp/settings").set("x-api-key", VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tenant_id: "tenant-1",
      plan: "growth",
      is_active: true,
      has_published_faq: true,
      position: "bottom-left",
      offset_x: 96,
      offset_y: 40,
      primary_color: "#3B82F6",
      excluded_page_patterns: ["/cart", "/checkout/*"],
      allowed_origins: ["https://example.com"],
    });
  });

  it("不正な形式のprimaryColorが直接DBに入っていた場合はnullとして扱う(直接DB操作への防御)", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            plan: "starter",
            is_active: true,
            widget_theme: { primaryColor: "not-a-color" },
            allowed_origins: [],
            excluded_page_patterns: [],
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ published_count: "0" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/wp/settings").set("x-api-key", VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.primary_color).toBeNull();
  });

  it("FAQ集計クエリが失敗してもレスポンス全体は壊さずhas_published_faq=falseにする", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ plan: "starter", is_active: true, widget_theme: {}, allowed_origins: [], excluded_page_patterns: [] }],
        rowCount: 1,
      })
      .mockRejectedValueOnce(new Error("faq_docs down"));
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/wp/settings").set("x-api-key", VALID_KEY);
    expect(res.status).toBe(200);
    expect(res.body.has_published_faq).toBe(false);
  });

  it("テナントが見つからない場合は404", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get("/v1/public/wp/settings").set("x-api-key", VALID_KEY);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/public/wp/settings", () => {
  it("フィールド未指定は400(DBに触れない)", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).patch("/v1/public/wp/settings").set("x-api-key", VALID_KEY).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_fields");
    expect(dbQuery).toHaveBeenCalledTimes(1); // 認証クエリのみ
  });

  it.each([
    ["positionが不正な値", { position: "top-left" }],
    ["offset_xが範囲外", { offset_x: 9999 }],
    ["offset_yが数値でも数字文字列でもない", { offset_y: "abc" }],
    ["primary_colorが#RRGGBB形式でない", { primary_color: "blue" }],
  ])("%s は400でDB更新に触れない(認証クエリのみ)", async (_label, body) => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).patch("/v1/public/wp/settings").set("x-api-key", VALID_KEY).send(body);
    expect(res.status).toBe(400);
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(updateTenantAllowedOrigins).not.toHaveBeenCalled();
  });

  it("allowed_originsにワイルドカード誤形式を送ると400(DBに触れない)", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/wp/settings")
      .set("x-api-key", VALID_KEY)
      .send({ allowed_origins: ["https://*evil.com"] });
    expect(res.status).toBe(400);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("excluded_page_patternsが/から始まらない場合は400(DBに触れない)", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/wp/settings")
      .set("x-api-key", VALID_KEY)
      .send({ excluded_page_patterns: ["cart"] });
    expect(res.status).toBe(400);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("position/offset更新は正しいSQLパラメータでUPDATEし、更新後の全体設定を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 }) // 認証
      .mockResolvedValueOnce({
        rows: [
          {
            plan: "starter",
            is_active: true,
            widget_theme: { position: "bottom-left", offsetX: 96, offsetY: 24 },
            allowed_origins: [],
            excluded_page_patterns: [],
          },
        ],
        rowCount: 1,
      }) // UPDATE
      .mockResolvedValueOnce({ rows: [{ published_count: "0" }], rowCount: 1 }); // FAQ有無
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/wp/settings")
      .set("x-api-key", VALID_KEY)
      .send({ position: "bottom-left", offset_x: 96 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tenant_id: "tenant-1",
      plan: "starter",
      is_active: true,
      has_published_faq: false,
      position: "bottom-left",
      offset_x: 96,
      offset_y: 24,
      primary_color: null,
      excluded_page_patterns: [],
      allowed_origins: [],
    });

    const [sql, params] = dbQuery.mock.calls[1];
    expect(sql).toContain("widget_theme = COALESCE(widget_theme, '{}') || $1::jsonb");
    expect(sql).toContain("UPDATE tenants SET");
    expect(sql).toContain("RETURNING plan, is_active, widget_theme, allowed_origins, excluded_page_patterns");
    expect(JSON.parse(params[0] as string)).toEqual({ position: "bottom-left", offsetX: 96 });
    expect(params[params.length - 1]).toBe("tenant-1");
    expect(updateTenantAllowedOrigins).not.toHaveBeenCalled();
  });

  it("allowed_origins更新は列を直接UPDATEし、インメモリtenantStoreも即時反映する", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            plan: "starter",
            is_active: true,
            widget_theme: {},
            allowed_origins: ["https://example.com"],
            excluded_page_patterns: [],
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ published_count: "0" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/wp/settings")
      .set("x-api-key", VALID_KEY)
      .send({ allowed_origins: ["https://example.com"] });

    expect(res.status).toBe(200);
    expect(res.body.allowed_origins).toEqual(["https://example.com"]);

    const [sql, params] = dbQuery.mock.calls[1];
    expect(sql).toContain("allowed_origins = $1");
    expect(params[0]).toEqual(["https://example.com"]);
    expect(updateTenantAllowedOrigins).toHaveBeenCalledWith("tenant-1", ["https://example.com"]);
  });

  it("テナントが見つからない場合は404", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/wp/settings")
      .set("x-api-key", VALID_KEY)
      .send({ position: "bottom-left" });
    expect(res.status).toBe(404);
  });

  it("DBエラー時は500", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: "tenant-1" }], rowCount: 1 })
      .mockRejectedValueOnce(new Error("db down"));
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .patch("/v1/public/wp/settings")
      .set("x-api-key", VALID_KEY)
      .send({ position: "bottom-left" });
    expect(res.status).toBe(500);
  });
});
