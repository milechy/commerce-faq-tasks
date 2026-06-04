// src/lib/book-pipeline/embedAndStore.test.ts
// F3 / Phase69-2-E: book-pipeline (embedAndStore) の ES write index がテナント別
// `faq_${tenantId}` であることを保証する。
//
// 背景: 旧実装はモジュールレベルの `process.env.ES_FAQ_INDEX ?? "faqs"` を使っており、
// read path（resolveFallbackIndices の `faq_${tenantId}`）と index 名が不整合だった。
// そのため書籍由来 doc が検索 index に届かず、book pipeline が無言で検索未反映になっていた。

import type { Pool } from "pg";
import { upsertToEs, embedAndStore } from "./embedAndStore";
import { resolveFaqWriteIndex } from "../../search/langIndex";
import type { StructuredChunk } from "./structurizer";

describe("embedAndStore upsertToEs — ES write index 統一 (F3 / Phase69-2-E)", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => jest.restoreAllMocks());

  it("書き込み先 index は faq_${tenantId}（read path と統一）", async () => {
    await upsertToEs("http://es.local:9200", "carnation", "book_1_chunk_0", {});
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(
      `http://es.local:9200/${resolveFaqWriteIndex("carnation")}/_doc/book_1_chunk_0`,
    );
    expect(url).toContain("/faq_carnation/_doc/");
    expect(url).not.toContain("/faqs/_doc/");
  });

  it("ES_FAQ_INDEX が設定されていても無視する（廃止済み）", async () => {
    const orig = process.env.ES_FAQ_INDEX;
    process.env.ES_FAQ_INDEX = "should_be_ignored";
    try {
      await upsertToEs("http://es.local:9200", "demo", "d", {});
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("/faq_demo/_doc/");
      expect(url).not.toContain("should_be_ignored");
    } finally {
      if (orig !== undefined) process.env.ES_FAQ_INDEX = orig;
      else delete process.env.ES_FAQ_INDEX;
    }
  });
});

describe("embedAndStore — tenantId が ES sync index まで伝播する (F3)", () => {
  const ORIG_ES_URL = process.env.ES_URL;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.ES_URL = "http://es.local:9200";
  });

  afterEach(() => {
    if (ORIG_ES_URL !== undefined) process.env.ES_URL = ORIG_ES_URL;
    else delete process.env.ES_URL;
    jest.restoreAllMocks();
  });

  it("ES sync 先 index がテナント別 faq_${tenantId} になる", async () => {
    const chunk: StructuredChunk = {
      chunkIndex: 0,
      pageNumber: 1,
      originalText: "原文テキスト",
      category: "概念",
      summary: "要約",
      keywords: ["k"],
      question: "質問",
      answer: "回答",
      confidence: 0.9,
    };
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ id: 42 }] }) };

    const ids = await embedAndStore("carnation", 7, [chunk], {
      db: db as unknown as Pool,
      embedFn: async () => [0.1, 0.2, 0.3],
    });

    expect(ids).toEqual([42]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain("/faq_carnation/_doc/book_7_chunk_0");
  });
});
