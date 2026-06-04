// src/api/admin/knowledge/faqCrudEsIndex.test.ts
// Phase69-2-E: FAQ CRUD の ES write path が read path と同じ faq_${tenantId} index を
// 参照することの統合テスト。
//
// 検証対象:
//   - POST   /v1/admin/knowledge/faq            → upsertToEsAsync  が faq_${tenantId}/_doc/ に PUT
//   - PATCH  /v1/admin/knowledge/faq/:id/exclude → syncIsExcludedToEsAsync が faq_${tenantId}/_update/ に POST
//   - DELETE /v1/admin/knowledge/faq/:id         → deleteFromEs が faq_${tenantId}/_doc/ に DELETE
//
// excludedIds.test.ts と同様、外部依存（DB / embedding / ES fetch）はモックする。

jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../../agent/llm/openaiEmbeddingClient", () => ({
  embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import type { Pool } from "pg";
import { registerFaqCrudRoutes } from "./faqCrudRoutes";
import { resolveFaqWriteIndex } from "../../../search/langIndex";

const TENANT = "demo";
const ES_URL = "http://es.test:9200";

// fetch をキャプチャ（ES への書き込み URL を記録）
type Captured = { url: string; method: string };
let captured: Captured[] = [];

const originalFetch = global.fetch;

function installFetchSpy() {
  // best-effort write path は応答 ok を返すだけでよい
  global.fetch = jest.fn(async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    captured.push({ url, method: init?.method ?? "GET" });
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

// pass-through middleware（認証層は本テストの対象外）
const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();

/** db.query / db.connect をモックする最小 Pool */
function makeMockPool(): { pool: Pool; setQuery: (fn: jest.Mock) => void } {
  const queryMock = jest.fn();
  const clientQuery = jest.fn(async (sql: string) => {
    if (/SELECT id, tenant_id FROM faq_docs WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return { rows: [{ id: 1, tenant_id: TENANT }], rowCount: 1 };
    }
    if (/UPDATE faq_docs SET is_excluded_from_search/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const pool = {
    query: queryMock,
    connect: jest.fn(async () => ({
      query: clientQuery,
      release: jest.fn(),
    })),
  } as unknown as Pool;
  return { pool, setQuery: (fn) => { (pool.query as unknown) = fn; } };
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  registerFaqCrudRoutes(app, pool, passThrough, passThrough, passThrough);
  return app;
}

const origEsUrl = process.env.ES_URL;
const origEsIndex = process.env.ES_FAQ_INDEX;

beforeEach(() => {
  captured = [];
  installFetchSpy();
  process.env.ES_URL = ES_URL;
  // 旧バグ再現防止: ES_FAQ_INDEX を別名にしても faq_${tenantId} に書くこと
  process.env.ES_FAQ_INDEX = "faqs";
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

afterAll(() => {
  if (origEsUrl !== undefined) process.env.ES_URL = origEsUrl; else delete process.env.ES_URL;
  if (origEsIndex !== undefined) process.env.ES_FAQ_INDEX = origEsIndex; else delete process.env.ES_FAQ_INDEX;
});

describe("FAQ CRUD ES write path — index 統一 (Phase69-2-E)", () => {
  it("POST /faq: upsert は faq_${tenantId}/_doc/ に書き込む（旧 'faqs' ではない）", async () => {
    const { pool } = makeMockPool();
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [{ id: 42, question: "q", answer: "a", is_published: true }],
      rowCount: 1,
    });
    const app = makeApp(pool);

    const res = await request(app)
      .post(`/v1/admin/knowledge/faq?tenant=${TENANT}`)
      .send({ question: "返品はできますか", answer: "30日以内なら可能です" });

    expect(res.status).toBe(201);

    // fire-and-forget の fetch が走るまで microtask を流す
    await new Promise((r) => setImmediate(r));

    const esWrites = captured.filter((c) => c.method === "PUT");
    expect(esWrites.length).toBeGreaterThan(0);
    const expectedIndex = resolveFaqWriteIndex(TENANT); // faq_demo
    expect(esWrites[0].url).toContain(`/${expectedIndex}/_doc/`);
    expect(esWrites[0].url).not.toContain("/faqs/_doc/");
    // doc id は ${faqId}_${tenantId}
    expect(esWrites[0].url).toContain(`/_doc/42_${TENANT}`);
  });

  it("PATCH /faq/:id/exclude: sync は faq_${tenantId}/_update/ に書き込む", async () => {
    const { pool } = makeMockPool();
    const app = makeApp(pool);

    const res = await request(app)
      .patch(`/v1/admin/knowledge/faq/1/exclude?tenant=${TENANT}`)
      .send({ is_excluded_from_search: true });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const esUpdates = captured.filter((c) => c.method === "POST");
    expect(esUpdates.length).toBeGreaterThan(0);
    const expectedIndex = resolveFaqWriteIndex(TENANT);
    expect(esUpdates[0].url).toContain(`/${expectedIndex}/_update/`);
    expect(esUpdates[0].url).not.toContain("/faqs/_update/");
    expect(esUpdates[0].url).toContain(`/_update/1_${TENANT}`);
  });

  it("DELETE /faq/:id: delete は faq_${tenantId}/_doc/ を対象にする", async () => {
    const { pool } = makeMockPool();
    (pool.query as jest.Mock).mockImplementation(async (sql: string) => {
      if (/SELECT id, tenant_id FROM faq_docs WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: 7, tenant_id: TENANT }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const app = makeApp(pool);

    const res = await request(app).delete(`/v1/admin/knowledge/faq/7?tenant=${TENANT}`);
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const esDeletes = captured.filter((c) => c.method === "DELETE");
    expect(esDeletes.length).toBeGreaterThan(0);
    const expectedIndex = resolveFaqWriteIndex(TENANT);
    expect(esDeletes[0].url).toContain(`/${expectedIndex}/_doc/`);
    expect(esDeletes[0].url).not.toContain("/faqs/_doc/");
    expect(esDeletes[0].url).toContain(`/_doc/7_${TENANT}`);
  });

  it("PATCH /exclude 後、同じ index に対する hybrid 読み取りパスと write index が一致する", () => {
    // write は faq_${tenantId}、read fallback の旧形式も faq_${tenantId}。
    // 両者が一致しないと exclude 同期が検索 index に届かない（Phase33-c バグ）。
    const writeIndex = resolveFaqWriteIndex(TENANT);
    // resolveFallbackIndices は read path（hybrid.ts）が使う。ここでは直接 langIndex で照合。
    const { resolveFallbackIndices } = jest.requireActual<typeof import("../../../search/langIndex")>(
      "../../../search/langIndex"
    );
    expect(resolveFallbackIndices(TENANT, "ja")).toContain(writeIndex);
  });
});
