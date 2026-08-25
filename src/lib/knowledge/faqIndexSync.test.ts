// src/lib/knowledge/faqIndexSync.test.ts
//
// FAQ検索索引（ES + pgvector）を書き込む単一実装のユニットテスト。
// faqCrudRoutes.ts / faqAdminRoutes.ts / faqImport.ts / actionExecutor.ts の
// 4つの呼び出し元が共有するため、ここで契約（ID規約・失敗時の挙動）を固定する。

jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockEmbedText = jest.fn();
jest.mock("../../agent/llm/openaiEmbeddingClient", () => ({
  embedText: (...args: unknown[]) => mockEmbedText(...args),
}));

jest.mock("../crypto/textEncrypt", () => ({
  encryptText: (s: string) => `enc(${s})`,
}));

import type { Pool } from "pg";
import { logger } from "../logger";
import {
  faqEsDocId,
  upsertFaqToEs,
  deleteFaqFromEs,
  syncFaqExcludedToEs,
  insertFaqEmbeddingAsync,
  countFaqIndexMismatch,
} from "./faqIndexSync";

const ES_URL = "http://es.test:9200";
const origEsUrl = process.env.ES_URL;

type Captured = { url: string; method: string; body?: string };
let captured: Captured[];
const originalFetch = global.fetch;

function installFetchSpy(ok = true) {
  global.fetch = jest.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    captured.push({ url, method: init?.method ?? "GET", body: init?.body });
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ count: 3 }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  captured = [];
  mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
  process.env.ES_URL = ES_URL;
});

afterEach(() => {
  global.fetch = originalFetch;
});

afterAll(() => {
  if (origEsUrl !== undefined) process.env.ES_URL = origEsUrl;
  else delete process.env.ES_URL;
});

describe("faqEsDocId", () => {
  it("唯一のID規約: `${faqId}_${tenantId}`", () => {
    expect(faqEsDocId("acme", 7)).toBe("7_acme");
  });
});

describe("upsertFaqToEs", () => {
  it("PUT /faq_<tenant>/_doc/<faqId>_<tenant> へ書き込む", async () => {
    installFetchSpy();
    upsertFaqToEs("acme", 7, "Q", "A", true, false);
    await new Promise((r) => setImmediate(r));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("PUT");
    expect(captured[0]!.url).toBe(`${ES_URL}/faq_acme/_doc/7_acme`);
    const body = JSON.parse(captured[0]!.body!);
    expect(body).toEqual({
      tenant_id: "acme",
      question: "Q",
      answer: "A",
      faq_id: 7,
      is_published: true,
      is_excluded_from_search: false,
    });
  });

  it("ES_URL未設定なら何もしない（fetchを呼ばない）", async () => {
    delete process.env.ES_URL;
    installFetchSpy();
    upsertFaqToEs("acme", 7, "Q", "A");
    await new Promise((r) => setImmediate(r));
    expect(captured).toHaveLength(0);
  });

  it("fetch失敗はlogger.errorに記録され、例外は投げない（fire-and-forget）", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    expect(() => upsertFaqToEs("acme", 7, "Q", "A")).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(logger.error).toHaveBeenCalledWith(
      "[faqIndexSync] ES upsert failed",
      expect.objectContaining({ tenantId: "acme", faqId: 7 })
    );
  });
});

describe("deleteFaqFromEs", () => {
  it("DELETE /faq_<tenant>/_doc/<faqId>_<tenant> を呼ぶ", async () => {
    installFetchSpy();
    await deleteFaqFromEs("acme", 7);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("DELETE");
    expect(captured[0]!.url).toBe(`${ES_URL}/faq_acme/_doc/7_acme`);
  });

  it("fetch失敗はthrowせずlogger.errorに記録する", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    await expect(deleteFaqFromEs("acme", 7)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "[faqIndexSync] ES delete failed",
      expect.objectContaining({ tenantId: "acme", faqId: 7 })
    );
  });
});

describe("syncFaqExcludedToEs", () => {
  it("POST /faq_<tenant>/_update/<faqId>_<tenant> へ部分更新する", async () => {
    installFetchSpy();
    syncFaqExcludedToEs("acme", 7, true);
    await new Promise((r) => setImmediate(r));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.url).toBe(`${ES_URL}/faq_acme/_update/7_acme`);
    expect(JSON.parse(captured[0]!.body!)).toEqual({ doc: { is_excluded_from_search: true } });
  });
});

describe("insertFaqEmbeddingAsync", () => {
  it("opts省略時は平文のままINSERTする（暗号化しない）", async () => {
    const queryMock = jest.fn().mockResolvedValue({ rows: [] });
    const db = { query: queryMock } as unknown as Pool;
    insertFaqEmbeddingAsync(db, "acme", "Q\nA", 7, { source: "test" });
    await new Promise((r) => setImmediate(r));
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO faq_embeddings"),
      expect.arrayContaining(["acme", "Q\nA"])
    );
  });

  // PR-2(2026-08-25収益監査): tenantId をスコープに持ちながら embedText に
  // 渡し忘れており、unknown計上され続けていた。
  it("embedTextにtenantIdとbillable:falseが渡される", async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    insertFaqEmbeddingAsync(db, "acme", "Q\nA", 7, { source: "test" });
    await new Promise((r) => setImmediate(r));
    expect(mockEmbedText).toHaveBeenCalledWith("Q\nA", { tenantId: "acme", billable: false });
  });

  it("opts.encrypt=trueなら本文を暗号化してからINSERTする", async () => {
    const queryMock = jest.fn().mockResolvedValue({ rows: [] });
    const db = { query: queryMock } as unknown as Pool;
    insertFaqEmbeddingAsync(db, "acme", "Q\nA", 7, { source: "test" }, { encrypt: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO faq_embeddings"),
      expect.arrayContaining(["acme", "enc(Q\nA)"])
    );
  });

  it("meta.is_excluded_from_search を is_excluded_from_search 列に反映する", async () => {
    const queryMock = jest.fn().mockResolvedValue({ rows: [] });
    const db = { query: queryMock } as unknown as Pool;
    insertFaqEmbeddingAsync(db, "acme", "Q\nA", 7, { is_excluded_from_search: true });
    await new Promise((r) => setImmediate(r));
    const call = queryMock.mock.calls[0]!;
    expect(call[1]).toEqual(["acme", "Q\nA", "[0.1,0.2,0.3]", expect.any(String), true]);
  });

  it("embedText失敗はDBに書き込まずlogger.errorに記録する", async () => {
    mockEmbedText.mockRejectedValue(new Error("openai down"));
    const queryMock = jest.fn();
    const db = { query: queryMock } as unknown as Pool;
    insertFaqEmbeddingAsync(db, "acme", "Q\nA", 7, {});
    await new Promise((r) => setImmediate(r));
    expect(queryMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "[faqIndexSync] embedding insert failed",
      expect.objectContaining({ tenantId: "acme", faqId: 7 })
    );
  });
});

describe("countFaqIndexMismatch", () => {
  it("DB件数・embedding欠落・孤児embedding・ES件数を返す", async () => {
    installFetchSpy();
    const query = jest.fn().mockImplementation((sql: string) => {
      if (/FROM faq_docs fd\s+WHERE fd\.tenant_id/.test(sql)) return Promise.resolve({ rows: [{ c: 1 }] });
      if (/FROM faq_embeddings fe/.test(sql)) return Promise.resolve({ rows: [{ c: 2 }] });
      return Promise.resolve({ rows: [{ c: 5 }] });
    });
    const pool = { query } as unknown as Pool;
    const result = await countFaqIndexMismatch(pool, "acme");
    expect(result).toEqual({ dbCount: 5, embeddingMissingCount: 1, orphanEmbeddingCount: 2, esCount: 3 });
  });

  it("孤児embeddingの判定は数値faq_idに限定する(book/OCR等の非FAQチャンクを誤検知しない)", async () => {
    installFetchSpy();
    const query = jest.fn().mockResolvedValue({ rows: [{ c: 0 }] });
    const pool = { query } as unknown as Pool;
    await countFaqIndexMismatch(pool, "acme");

    const orphanCall = query.mock.calls.find(
      ([sql]: [string]) => /^\s*SELECT COUNT\(\*\)::int AS c\s+FROM faq_embeddings fe/.test(sql),
    );
    expect(orphanCall![0]).toContain("faq_id' ~ '^[0-9]+$'");
  });

  it("embedding欠落の判定はテナント一致した faq_id 参照の有無で行う", async () => {
    installFetchSpy();
    const query = jest.fn().mockResolvedValue({ rows: [{ c: 0 }] });
    const pool = { query } as unknown as Pool;
    await countFaqIndexMismatch(pool, "acme");

    const missingCall = query.mock.calls.find(([sql]: [string]) => /FROM faq_docs fd/.test(sql));
    expect(missingCall![0]).toContain("fe.tenant_id = fd.tenant_id");
    expect(missingCall![0]).toContain("fe.metadata->>'faq_id' = fd.id::text");
  });

  it("ES_URL未設定ならesCount=-1を返し、fetchしない", async () => {
    delete process.env.ES_URL;
    installFetchSpy();
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ c: 5 }] }),
    } as unknown as Pool;
    const result = await countFaqIndexMismatch(pool, "acme");
    expect(result).toEqual({ dbCount: 5, embeddingMissingCount: 5, orphanEmbeddingCount: 5, esCount: -1 });
    expect(captured).toHaveLength(0);
  });

  it("ESが非200を返せばesCount=-1（不整合が誤って「一致」に見えないようにする）", async () => {
    installFetchSpy(false);
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ c: 5 }] }),
    } as unknown as Pool;
    const result = await countFaqIndexMismatch(pool, "acme");
    expect(result).toEqual({ dbCount: 5, embeddingMissingCount: 5, orphanEmbeddingCount: 5, esCount: -1 });
  });
});
