// src/api/widget/wpProvisionRoutes.test.ts
//
// 要件書 docs/WORDPRESS_PLUGIN_REQUIREMENTS.md の受け入れ条件を固定する:
//   A-2  未接続状態で外部通信0件(このファイルでは safeFetch を必ずモックし、
//        検証成功パス以外で実ネットワークに触れないことを保証する)
//   C-1  サイト所有証明を通さずにキーが発行できない
//   C-3  発行キーが登録originに束縛される(tenants.allowed_origins)
//   X-3 / I-3 / I-4  同一originへの二重発行を作らない
//   禁止20  「存在しない」と「期限切れ」を区別する

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { registerWpProvisionRoutes } from "./wpProvisionRoutes";
import { hashApiKey } from "../admin/tenants/apiKeyUtils";
import * as siteVerifier from "./wpSiteVerifier";

// rate-limit.ts の store はモジュール単位のシングルトンで、テストごとにリセット
// されない(本番ではそれが正しい挙動)。このファイルは1プロセス内で20件を大きく
// 超えるリクエストを発行するため、実際のレート制限に引っかかって無関係なテストが
// 429で落ちる。レート制限自体は rate-limit.ts 側で別途テストされている前提で、
// ここではルーティング・状態遷移のロジックだけを見るために無効化する。
jest.mock("../../lib/rate-limit", () => ({
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("./wpSiteVerifier", () => {
  const actual = jest.requireActual("./wpSiteVerifier");
  return { ...actual, verifyWpSiteChallenge: jest.fn() };
});
const mockVerify = siteVerifier.verifyWpSiteChallenge as jest.Mock;

jest.mock("../../lib/tenant-context", () => ({
  registerTenant: jest.fn(),
}));
import { registerTenant } from "../../lib/tenant-context";

function makeApp(db: any) {
  const app = express();
  app.use(express.json());
  registerWpProvisionRoutes(app, db);
  return app;
}

/** db.connect() が返す PoolClient 風オブジェクトを、クエリの内容に応じて振る舞わせる。 */
function makeTxClient(handlers: {
  onSelectForUpdate?: (params: unknown[]) => { rows: any[]; rowCount?: number };
  onFindProvisionedByOrigin?: () => { rows: any[]; rowCount?: number };
  onCountProvisioned?: () => { rows: any[]; rowCount?: number };
  onCountCreatedSince?: () => { rows: any[]; rowCount?: number };
  onInsertTenant?: (params: unknown[]) => void;
  onInsertKey?: (params: unknown[]) => void;
  onMarkProvisioned?: (params: unknown[]) => { rows: any[]; rowCount?: number };
}) {
  const calls: Array<[string, unknown[]]> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push([sql, params]);
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm === "BEGIN" || norm === "SET LOCAL lock_timeout = '3s'" || norm === "COMMIT" || norm === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("SELECT status, site_origin, site_name, tenant_id FROM wp_provisionings")) {
      return handlers.onSelectForUpdate?.(params) ?? { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("SELECT") && norm.includes("wp_provisionings") && norm.includes("status = 'provisioned'") && norm.includes("site_origin = $1")) {
      return handlers.onFindProvisionedByOrigin?.() ?? { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("SELECT COUNT(*)::int AS count FROM wp_provisionings WHERE status = 'provisioned'")) {
      return handlers.onCountProvisioned?.() ?? { rows: [{ count: 0 }], rowCount: 1 };
    }
    if (norm.startsWith("SELECT COUNT(*)::int AS count FROM wp_provisionings WHERE created_at")) {
      return handlers.onCountCreatedSince?.() ?? { rows: [{ count: 0 }], rowCount: 1 };
    }
    if (norm.startsWith("INSERT INTO tenants")) {
      handlers.onInsertTenant?.(params);
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("INSERT INTO tenant_api_keys")) {
      handlers.onInsertKey?.(params);
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE wp_provisionings") && norm.includes("status = 'provisioned'")) {
      return handlers.onMarkProvisioned?.(params) ?? { rows: [], rowCount: 1 };
    }
    throw new Error(`makeTxClient: unexpected query: ${norm}`);
  });
  const release = jest.fn();
  return { client: { query, release }, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /v1/public/wp/provision", () => {
  it("db未接続なら503", async () => {
    const app = makeApp(null);
    const res = await request(app).post("/v1/public/wp/provision").send({});
    expect(res.status).toBe(503);
  });

  it.each([
    ["site_url欠落", { email: "a@example.com" }],
    ["emailが不正な形式", { site_url: "https://example.com", email: "not-an-email" }],
  ])("%s は400(DBに触れない)", async (_label, body) => {
    const dbQuery = jest.fn();
    const app = makeApp({ query: dbQuery });
    const res = await request(app).post("/v1/public/wp/provision").send(body);
    expect(res.status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["http", "http://example.com"],
    ["localhost", "https://localhost"],
    ["内部IP", "https://192.168.1.1"],
  ])("site_urlが%sなら400で理由コードを返す(DBに触れない)", async (_label, site_url) => {
    const dbQuery = jest.fn();
    const app = makeApp({ query: dbQuery });
    const res = await request(app).post("/v1/public/wp/provision").send({ site_url, email: "a@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^site_url_/);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("同一originに確定済みテナントがあれば409で、tenantIdを漏らさない", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({
      rows: [{ id: "row-1", site_origin: "https://example.com", status: "provisioned", tenant_id: "wp-example-abcd" }],
      rowCount: 1,
    });
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .post("/v1/public/wp/provision")
      .send({ site_url: "https://example.com", email: "a@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_connected");
    expect(JSON.stringify(res.body)).not.toContain("wp-example-abcd");
  });

  it("正常な申告は201でchallenge/poll_tokenを返し、平文チャレンジは保存クエリに現れない", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 既存originチェック
      .mockResolvedValueOnce({ rows: [{ id: "row-1" }], rowCount: 1 }); // createWpProvisioning
    const app = makeApp({ query: dbQuery });
    const res = await request(app)
      .post("/v1/public/wp/provision")
      .send({ site_url: "https://example.com/", email: "a@example.com", site_name: "My Shop" });

    expect(res.status).toBe(201);
    expect(res.body.challenge).toMatch(/^wpc_[0-9a-f]{64}$/);
    expect(res.body.poll_token).toMatch(/^wpp_[0-9a-f]{64}$/);
    expect(res.body.verify_path).toBe("/wp-json/r2c/v1/verify");

    // INSERT に渡された origin は末尾スラッシュを落とした正規化済みの値
    const insertCall = dbQuery.mock.calls[1];
    expect(insertCall[1][0]).toBe("https://example.com");
    // 平文チャレンジ/トークンがそのままSQLパラメータに現れない(ハッシュのみ)
    expect(insertCall[1]).not.toContain(res.body.challenge);
    expect(insertCall[1]).not.toContain(res.body.poll_token);
  });
});

describe("GET /v1/public/wp/provision/:token", () => {
  const TOKEN = "wpp_" + "a".repeat(64);

  it("db未接続なら503", async () => {
    const app = makeApp(null);
    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(503);
  });

  it("見つからないトークンは404 not_found", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // expireStaleWpProvisionings
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // findByPollTokenHash
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("not_found");
  });

  // 禁止20: 「存在しない」と「期限切れ」を同じ値で表現しない
  it("status=expired の行は200でexpiredを返す(404ではない)", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "expired", site_origin: "https://example.com", tenant_id: null, failure_reason: null, created_at: new Date() }],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("expired");
  });

  it("status=failed の行は理由を返す", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "failed", site_origin: "https://example.com", tenant_id: null, failure_reason: "site_unreachable", created_at: new Date() }],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "failed", reason: "site_unreachable" });
  });

  it("status=provisioned の行はtenantIdのみ返し、api_keyは含まない(再ポーリングで漏らさない)", async () => {
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "provisioned", site_origin: "https://example.com", tenant_id: "wp-example-abcd", failure_reason: null, created_at: new Date() }],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "provisioned", tenant_id: "wp-example-abcd" });
    expect(res.body.api_key).toBeUndefined();
  });

  it("24時間を超えたpendingの行は書き込みを試みずexpiredを返す", async () => {
    const oldCreatedAt = new Date(Date.now() - 25 * 3600_000);
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "pending", site_origin: "https://example.com", tenant_id: null, failure_reason: null, created_at: oldCreatedAt }],
        rowCount: 1,
      });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("expired");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("pendingでサイト検証に失敗した場合は理由付きでpendingのまま返す(failedにしない)", async () => {
    mockVerify.mockResolvedValueOnce({ ok: false, reason: "http_error", httpStatus: 401 });
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // expire sweep
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "pending", site_origin: "https://example.com", tenant_id: null, failure_reason: null, created_at: new Date() }],
        rowCount: 1,
      }) // findByPollTokenHash
      .mockResolvedValueOnce({ rows: [{ challenge_hash: "hash-x" }], rowCount: 1 }); // getWpProvisioningChallengeHashForVerification
    const app = makeApp({ query: dbQuery });
    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "pending", verify_reason: "http_error" });
    expect(mockVerify).toHaveBeenCalledWith("https://example.com", "hash-x");
  });

  it("pending→検証成功→発行まで一気通貫で完了し、api_keyを一度だけ返す", async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const { client, calls } = makeTxClient({
      onSelectForUpdate: () => ({
        rows: [{ status: "site_verified", site_origin: "https://example.com", site_name: "My Shop", tenant_id: null }],
        rowCount: 1,
      }),
      onFindProvisionedByOrigin: () => ({ rows: [], rowCount: 0 }),
      onCountProvisioned: () => ({ rows: [{ count: 3 }], rowCount: 1 }),
      onCountCreatedSince: () => ({ rows: [{ count: 1 }], rowCount: 1 }),
      onMarkProvisioned: () => ({ rows: [], rowCount: 1 }),
    });
    const connect = jest.fn().mockResolvedValue(client);
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // expire sweep
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "pending", site_origin: "https://example.com", tenant_id: null, failure_reason: null, created_at: new Date() }],
        rowCount: 1,
      }) // findByPollTokenHash
      .mockResolvedValueOnce({ rows: [{ challenge_hash: "hash-x" }], rowCount: 1 }) // challenge hash取得
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // markWpProvisioningSiteVerified
    const app = makeApp({ query: dbQuery, connect });

    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("provisioned");
    expect(res.body.tenant_id).toMatch(/^wp-example-[0-9a-f]{8}$/);
    expect(typeof res.body.api_key).toBe("string");
    expect(res.body.api_key.startsWith("rjc_")).toBe(true);

    // ★C-3: allowed_origins にこのサイトのoriginが束縛されている★
    const insertTenantCall = calls.find(([sql]) => sql.includes("INSERT INTO tenants"));
    expect(insertTenantCall).toBeDefined();
    // INSERT INTO tenants (id, name, plan, is_active, allowed_origins)
    // VALUES ($1, $2, 'free_ad', true, $3) — plan/is_active はリテラルなので
    // パラメータ配列は [id, name, allowedOrigins] の3要素(index 0,1,2)。
    expect(insertTenantCall![1][2]).toEqual(["https://example.com"]);

    // 発行された平文キーのハッシュがINSERT tenant_api_keysに渡っている
    const insertKeyCall = calls.find(([sql]) => sql.includes("INSERT INTO tenant_api_keys"));
    expect(insertKeyCall).toBeDefined();
    expect(insertKeyCall![1][1]).toBe(hashApiKey(res.body.api_key));

    // ★registerTenant に空文字ではなく実ハッシュが渡っている★
    // (空文字を渡すと getTenantByApiKeyHash が常にfalseになり、発行した鍵が
    //  永久に /api/chat を通らないバグになる)
    expect(registerTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        security: expect.objectContaining({
          apiKeyHash: hashApiKey(res.body.api_key),
          allowedOrigins: ["https://example.com"],
        }),
      })
    );
  });

  // ★C-1の本体: サイト所有証明(verifyWpSiteChallenge)が失敗する限り、
  // completeWpProvisioning(トランザクション側)には一切到達しない★
  it("検証が失敗する限りテナントもキーも作られない", async () => {
    mockVerify.mockResolvedValueOnce({ ok: false, reason: "challenge_mismatch" });
    const connect = jest.fn();
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "pending", site_origin: "https://example.com", tenant_id: null, failure_reason: null, created_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ challenge_hash: "hash-x" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery, connect });

    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(connect).not.toHaveBeenCalled();
    expect(registerTenant).not.toHaveBeenCalled();
  });

  // D7: 総量ガード到達時は「順番待ち」として扱い、エラーで落とさない
  it("同時稼働数の上限到達時は pending + wait_reason を返す(500系にしない)", async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const { client } = makeTxClient({
      onSelectForUpdate: () => ({
        rows: [{ status: "site_verified", site_origin: "https://example.com", site_name: null, tenant_id: null }],
        rowCount: 1,
      }),
      onFindProvisionedByOrigin: () => ({ rows: [], rowCount: 0 }),
      onCountProvisioned: () => ({ rows: [{ count: 100 }], rowCount: 1 }), // ちょうど上限
    });
    const connect = jest.fn().mockResolvedValue(client);
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "pending", site_origin: "https://example.com", tenant_id: null, failure_reason: null, created_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ challenge_hash: "hash-x" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // markWpProvisioningSiteVerified
    const app = makeApp({ query: dbQuery, connect });

    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "pending", wait_reason: "capacity_reached" });
    expect(registerTenant).not.toHaveBeenCalled();
  });

  // I-3/I-4: プラグイン削除→再インストール等で同一originから2度目の申告があっても、
  // completeWpProvisioning は新規発行せず既存のtenantIdを返す。
  it("トランザクション内で同一originの確定行が見つかれば新規発行しない", async () => {
    mockVerify.mockResolvedValueOnce({ ok: true });
    const { client } = makeTxClient({
      onSelectForUpdate: () => ({
        rows: [{ status: "site_verified", site_origin: "https://example.com", site_name: null, tenant_id: null }],
        rowCount: 1,
      }),
      onFindProvisionedByOrigin: () => ({
        rows: [{ id: "row-2", tenant_id: "wp-example-existing", status: "provisioned", site_origin: "https://example.com", failure_reason: null, created_at: new Date(), site_verified_at: null, email_verified_at: null, provisioned_at: new Date(), email: "x@example.com" }],
        rowCount: 1,
      }),
    });
    const connect = jest.fn().mockResolvedValue(client);
    const dbQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: "row-1", status: "pending", site_origin: "https://example.com", tenant_id: null, failure_reason: null, created_at: new Date() }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ challenge_hash: "hash-x" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const app = makeApp({ query: dbQuery, connect });

    const res = await request(app).get(`/v1/public/wp/provision/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "provisioned", tenant_id: "wp-example-existing" });
    expect(registerTenant).not.toHaveBeenCalled();
  });
});

describe("POST /v1/public/wp/disconnect", () => {
  it("db未接続なら503", async () => {
    const app = makeApp(null);
    const res = await request(app).post("/v1/public/wp/disconnect").set("x-api-key", "rjc_x");
    expect(res.status).toBe(503);
  });

  it("x-api-keyヘッダが無ければ401", async () => {
    const dbQuery = jest.fn();
    const app = makeApp({ query: dbQuery });
    const res = await request(app).post("/v1/public/wp/disconnect");
    expect(res.status).toBe(401);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("無効なキー(該当行なし)は401で、キーの存在有無を漏らさない", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).post("/v1/public/wp/disconnect").set("x-api-key", "rjc_invalid");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });

  it("有効なキーは失効し、テナント削除には触れないことをメッセージで示す", async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ tenant_id: "wp-example-abcd" }], rowCount: 1 });
    const app = makeApp({ query: dbQuery });
    const res = await request(app).post("/v1/public/wp/disconnect").set("x-api-key", "rjc_validkey");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain("削除されません");

    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("UPDATE tenant_api_keys");
    expect(sql).toContain("is_active = false");
    expect(params[0]).toBe(hashApiKey("rjc_validkey"));
  });
});
