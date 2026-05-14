// tests/faqCrud.test.ts
// Phase30: FAQ CRUD API unit tests

import express from "express";
import type { Express } from "express";
import { registerFaqCrudRoutes } from "../src/api/admin/knowledge/faqCrudRoutes";

// ---------------------------------------------------------------------------
// Mock: embedText (openaiEmbeddingClient)
// ---------------------------------------------------------------------------
jest.mock("../src/agent/llm/openaiEmbeddingClient", () => ({
  embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

// ---------------------------------------------------------------------------
// Mock: global fetch for ES upsert / delete
// ---------------------------------------------------------------------------
const mockFetch = jest.fn().mockResolvedValue({ ok: true });
global.fetch = mockFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers: build a mock pg Pool
// ---------------------------------------------------------------------------
function makeMockDb(queryImpl: jest.Mock) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { query: queryImpl } as any;
}

// ---------------------------------------------------------------------------
// Helper: build minimal Express app with the routes registered
// ---------------------------------------------------------------------------
function buildApp(queryImpl: jest.Mock): Express {
  const app = express();
  app.use(express.json());
  const db = makeMockDb(queryImpl);
  // テストではauth/role/tenantチェックをすべてパススルー
  // テナント指定は x-tenant-id ヘッダー経由でルートハンドラが直接処理する
  const noop = (_req: any, _res: any, next: any) => next();  // eslint-disable-line @typescript-eslint/no-explicit-any
  registerFaqCrudRoutes(app, db, noop, noop, noop);
  return app;
}

// ---------------------------------------------------------------------------
// Inline HTTP helper (avoids supertest dependency)
// Uses Node http module to send requests to the app's server
// ---------------------------------------------------------------------------
import * as http from "http";

function request(
  app: Express,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as { port: number };
      const port = addr.port;
      const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
      const reqHeaders: http.OutgoingHttpHeaders = {
        "x-tenant-id": "tenant-test",
        ...(opts.headers ?? {}),
      };
      if (bodyStr !== undefined) {
        reqHeaders["Content-Type"] = "application/json";
        reqHeaders["Content-Length"] = Buffer.byteLength(bodyStr);
      }
      const req = http.request(
        { hostname: "127.0.0.1", port, method, path, headers: reqHeaders },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        }
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (bodyStr !== undefined) req.write(bodyStr);
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/admin/knowledge/faq", () => {
  it("returns paginated list with total", async () => {
    const fakeRow = {
      id: 1,
      tenant_id: "tenant-test",
      question: "Q1",
      answer: "A1",
      category: "inventory",
      tags: [],
      is_published: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const queryMock = jest
      .fn()
      // First call: COUNT
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      // Second call: SELECT items
      .mockResolvedValueOnce({ rows: [fakeRow] });

    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq");

    expect(res.status).toBe(200);
    const body = res.body as { items: unknown[]; total: number; limit: number; offset: number };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("returns 400 when tenant header is missing", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq", { headers: { "x-tenant-id": "" } });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/knowledge/faq/:id", () => {
  it("returns 404 when FAQ not found", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq/999");
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe("FAQが見つかりません");
  });

  it("returns 403 on tenant mismatch", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 1, tenant_id: "other-tenant", question: "Q", answer: "A" }],
    });
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq/1");
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("アクセス権限がありません");
  });

  it("returns the FAQ row when found and tenant matches", async () => {
    const fakeRow = {
      id: 1,
      tenant_id: "tenant-test",
      question: "Q1",
      answer: "A1",
      category: "campaign",
      tags: ["tag1"],
      is_published: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const queryMock = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [fakeRow] });
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq/1");
    expect(res.status).toBe(200);
    expect((res.body as { question: string }).question).toBe("Q1");
  });

  it("returns 400 for non-numeric id", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq/abc");
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/admin/knowledge/faq", () => {
  it("creates FAQ and returns 201", async () => {
    const createdRow = {
      id: 42,
      tenant_id: "tenant-test",
      question: "新しいQ",
      answer: "新しいA",
      category: "coupon",
      tags: [],
      is_published: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const queryMock = jest.fn().mockResolvedValueOnce({ rows: [createdRow] });
    const app = buildApp(queryMock);

    mockFetch.mockClear();

    const res = await request(app, "POST", "/v1/admin/knowledge/faq", {
      body: { question: "新しいQ", answer: "新しいA", category: "coupon" },
    });

    expect(res.status).toBe(201);
    expect((res.body as { id: number }).id).toBe(42);
    // At least one DB call should be the INSERT INTO faq_docs
    const insertCall = queryMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO faq_docs")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain("INSERT INTO faq_docs");
  });

  it("returns 400 on Zod validation failure", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    // question too short (empty)
    const res = await request(app, "POST", "/v1/admin/knowledge/faq", {
      body: { question: "", answer: "A" },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_request");
  });

  it("returns 400 when tenant is missing", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "POST", "/v1/admin/knowledge/faq", {
      headers: { "x-tenant-id": "" },
      body: { question: "Q", answer: "A" },
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /v1/admin/knowledge/faq/:id", () => {
  it("returns 404 when FAQ not found", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const app = buildApp(queryMock);
    const res = await request(app, "PUT", "/v1/admin/knowledge/faq/999", {
      body: { question: "Q", answer: "A" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 on tenant mismatch", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 1, tenant_id: "other-tenant" }],
    });
    const app = buildApp(queryMock);
    const res = await request(app, "PUT", "/v1/admin/knowledge/faq/1", {
      body: { question: "Q", answer: "A" },
    });
    expect(res.status).toBe(403);
  });

  it("updates FAQ and returns updated row", async () => {
    const updatedRow = {
      id: 1,
      tenant_id: "tenant-test",
      question: "Updated Q",
      answer: "Updated A",
      category: "store_info",
      tags: ["t1"],
      is_published: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const queryMock = jest
      .fn()
      // 1st: SELECT check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, tenant_id: "tenant-test" }] })
      // 2nd: UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [updatedRow] })
      // 3rd: DELETE embeddings
      .mockResolvedValueOnce({ rowCount: 0 });

    const app = buildApp(queryMock);
    const res = await request(app, "PUT", "/v1/admin/knowledge/faq/1", {
      body: { question: "Updated Q", answer: "Updated A", category: "store_info", is_published: false },
    });

    expect(res.status).toBe(200);
    expect((res.body as { question: string }).question).toBe("Updated Q");
  });

  it("returns 400 for non-numeric id", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "PUT", "/v1/admin/knowledge/faq/abc", {
      body: { question: "Q", answer: "A" },
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/admin/knowledge/faq/:id", () => {
  it("deletes FAQ and returns { ok: true, id }", async () => {
    const queryMock = jest
      .fn()
      // 1st: SELECT check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, tenant_id: "tenant-test" }] })
      // 2nd: DELETE faq_embeddings
      .mockResolvedValueOnce({ rowCount: 0 })
      // 3rd: DELETE faq_docs
      .mockResolvedValueOnce({ rowCount: 1 });

    const app = buildApp(queryMock);
    const res = await request(app, "DELETE", "/v1/admin/knowledge/faq/5");

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(5);
  });

  it("returns 404 when FAQ not found", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const app = buildApp(queryMock);
    const res = await request(app, "DELETE", "/v1/admin/knowledge/faq/404");
    expect(res.status).toBe(404);
  });

  it("returns 403 on tenant mismatch", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 1, tenant_id: "other-tenant" }],
    });
    const app = buildApp(queryMock);
    const res = await request(app, "DELETE", "/v1/admin/knowledge/faq/1");
    expect(res.status).toBe(403);
  });

  it("returns 400 when tenant is missing", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "DELETE", "/v1/admin/knowledge/faq/1", {
      headers: { "x-tenant-id": "" },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Phase69-2 PR-C2 Round 2: PATCH /v1/admin/knowledge/faq/:id/exclude
// Codex adversarial Round 1 指摘 (HIGH×2, MEDIUM×1) の回帰テスト
// ---------------------------------------------------------------------------

// Transaction-aware mock helper: db.query (pool-level) + db.connect (client-level)
function makeTxMockDb(
  poolQueryImpl: jest.Mock,
  clientQueryImpl: jest.Mock,
  releaseImpl?: jest.Mock,
) {
  const client = {
    query: clientQueryImpl,
    release: releaseImpl ?? jest.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    query: poolQueryImpl,
    connect: jest.fn().mockResolvedValue(client),
    __client: client,
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function buildAppTx(
  poolQueryImpl: jest.Mock,
  clientQueryImpl: jest.Mock,
  releaseImpl?: jest.Mock,
): { app: Express; db: ReturnType<typeof makeTxMockDb> } {
  const app = express();
  app.use(express.json());
  const db = makeTxMockDb(poolQueryImpl, clientQueryImpl, releaseImpl);
  const noop = (_req: any, _res: any, next: any) => next(); // eslint-disable-line @typescript-eslint/no-explicit-any
  registerFaqCrudRoutes(app, db, noop, noop, noop);
  return { app, db };
}

describe("PATCH /v1/admin/knowledge/faq/:id/exclude (Phase69-2 PR-C2 Round 2)", () => {
  const ORIGINAL_ES_URL = process.env.ES_URL;

  beforeEach(() => {
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({ ok: true });
    process.env.ES_URL = "http://es.test:9200";
    process.env.ES_FAQ_INDEX = "faqs";
  });

  afterAll(() => {
    if (ORIGINAL_ES_URL === undefined) delete process.env.ES_URL;
    else process.env.ES_URL = ORIGINAL_ES_URL;
  });

  it("[HIGH-1] propagates is_excluded_from_search to ES via POST _update (partial doc)", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 42, tenant_id: "tenant-test" }],
    });
    const clientQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
    const { app } = buildAppTx(poolQuery, clientQuery);

    const res = await request(app, "PATCH", "/v1/admin/knowledge/faq/42/exclude", {
      body: { is_excluded_from_search: true },
    });

    expect(res.status).toBe(200);
    // ES fire-and-forget は非同期。次のイベントループまで待つ
    await new Promise((r) => setImmediate(r));
    const esCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/_update/42_tenant-test"),
    );
    expect(esCalls).toHaveLength(1);
    const call = esCalls[0];
    expect(call[1]?.method).toBe("POST");
    expect(JSON.parse(call[1]?.body as string)).toEqual({
      doc: { is_excluded_from_search: true },
    });
  });

  it("[HIGH-1] also propagates is_excluded_from_search=false (un-exclude)", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 7, tenant_id: "tenant-test" }],
    });
    const clientQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
    const { app } = buildAppTx(poolQuery, clientQuery);

    const res = await request(app, "PATCH", "/v1/admin/knowledge/faq/7/exclude", {
      body: { is_excluded_from_search: false },
    });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    const esCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/_update/7_tenant-test"),
    );
    expect(esCalls).toHaveLength(1);
    expect(JSON.parse(esCalls[0][1]?.body as string)).toEqual({
      doc: { is_excluded_from_search: false },
    });
  });

  it("[HIGH-2] wraps both UPDATEs in a single transaction (BEGIN/COMMIT)", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 1, tenant_id: "tenant-test" }],
    });
    const clientQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
    const release = jest.fn();
    const { app, db } = buildAppTx(poolQuery, clientQuery, release);

    const res = await request(app, "PATCH", "/v1/admin/knowledge/faq/1/exclude", {
      body: { is_excluded_from_search: true },
    });

    expect(res.status).toBe(200);
    expect(db.connect).toHaveBeenCalled();
    const sqls = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("lock_timeout");
    expect(sqls[2]).toContain("UPDATE faq_docs");
    expect(sqls[3]).toContain("UPDATE faq_embeddings");
    expect(sqls[4]).toBe("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("[HIGH-2] ROLLBACK and returns 500 when faq_embeddings UPDATE fails; ES sync is not called", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 2, tenant_id: "tenant-test" }],
    });
    // BEGIN, SET, UPDATE faq_docs OK; UPDATE faq_embeddings rejects; ROLLBACK
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 }) // SET lock_timeout
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE faq_docs
      .mockRejectedValueOnce(new Error("cast error")) // UPDATE faq_embeddings
      .mockResolvedValueOnce({ rowCount: 0 }); // ROLLBACK
    const release = jest.fn();
    const { app } = buildAppTx(poolQuery, clientQuery, release);

    const initialEsCalls = mockFetch.mock.calls.length;
    const res = await request(app, "PATCH", "/v1/admin/knowledge/faq/2/exclude", {
      body: { is_excluded_from_search: true },
    });

    expect(res.status).toBe(500);
    const sqls = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    // ES 同期は COMMIT 後にしか呼ばれない → エラー時は呼ばれない
    const esUpdateCalls = mockFetch.mock.calls
      .slice(initialEsCalls)
      .filter((c) => String(c[0]).includes("/_update/"));
    expect(esUpdateCalls).toHaveLength(0);
  });

  it("[HIGH-2] returns 409 with errorCode DB_LOCK_TIMEOUT when PostgreSQL lock_timeout (55P03) fires", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 3, tenant_id: "tenant-test" }],
    });
    const lockErr = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 }) // SET lock_timeout
      .mockRejectedValueOnce(lockErr) // UPDATE faq_docs → lock timeout
      .mockResolvedValueOnce({ rowCount: 0 }); // ROLLBACK
    const release = jest.fn();
    const { app } = buildAppTx(poolQuery, clientQuery, release);

    const res = await request(app, "PATCH", "/v1/admin/knowledge/faq/3/exclude", {
      body: { is_excluded_from_search: true },
    });

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/少し時間/);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("[MEDIUM-1] embeddings UPDATE SQL includes numeric guard for metadata->>'faq_id'", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 9, tenant_id: "tenant-test" }],
    });
    const clientQuery = jest.fn().mockResolvedValue({ rowCount: 0 });
    const { app } = buildAppTx(poolQuery, clientQuery);

    await request(app, "PATCH", "/v1/admin/knowledge/faq/9/exclude", {
      body: { is_excluded_from_search: true },
    });

    const embeddingsCall = clientQuery.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE faq_embeddings"),
    );
    expect(embeddingsCall).toBeDefined();
    expect(String(embeddingsCall![0])).toMatch(/~ '\^\[0-9\]\+\$'/);
  });

  it("returns 404 when FAQ does not exist (no transaction opened)", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const clientQuery = jest.fn();
    const { app, db } = buildAppTx(poolQuery, clientQuery);

    const res = await request(app, "PATCH", "/v1/admin/knowledge/faq/999/exclude", {
      body: { is_excluded_from_search: true },
    });

    expect(res.status).toBe(404);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("returns 403 on tenant mismatch (no transaction opened)", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 5, tenant_id: "other-tenant" }],
    });
    const clientQuery = jest.fn();
    const { app, db } = buildAppTx(poolQuery, clientQuery);

    const res = await request(app, "PATCH", "/v1/admin/knowledge/faq/5/exclude", {
      body: { is_excluded_from_search: true },
    });

    expect(res.status).toBe(403);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("returns 200 even if ES sync fails (fire-and-forget — DB is source-of-truth)", async () => {
    const poolQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 11, tenant_id: "tenant-test" }],
    });
    const clientQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
    const { app } = buildAppTx(poolQuery, clientQuery);

    // ES sync が失敗してもAPIは成功
    mockFetch.mockRejectedValueOnce(new Error("ES connection refused"));

    const res = await request(app, "PATCH", "/v1/admin/knowledge/faq/11/exclude", {
      body: { is_excluded_from_search: true },
    });

    expect(res.status).toBe(200);
    expect((res.body as { is_excluded_from_search: boolean }).is_excluded_from_search).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase69-2 PR-C2 Round 2: hybrid.ts ES クエリ永続フィルター回帰
// ---------------------------------------------------------------------------
describe("hybridSearch ES query — is_excluded_from_search must_not filter (Phase69-2 PR-C2 Round 2)", () => {
  it("ES filter.bool.must includes a must_not for is_excluded_from_search: true", () => {
    // hybrid.ts のクエリ構造を文字列レベルで検証（実 ES 呼び出し不要）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const hybridSrc = fs.readFileSync(
      path.join(__dirname, "../src/search/hybrid.ts"),
      "utf-8",
    );
    expect(hybridSrc).toMatch(/must_not:\s*{\s*term:\s*{\s*is_excluded_from_search:\s*true\s*}\s*}/);
  });
});
