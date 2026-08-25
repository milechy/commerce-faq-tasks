// src/lib/knowledge/bookIndexPreservation.test.ts

import { findBookChunkDocIds, copyBookDocsToNewIndex } from "./bookIndexPreservation";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe("findBookChunkDocIds", () => {
  it("source='book'系(bookとbook:pdf:qwen-ocrの両方)を数値book_id/chunk_indexから拾う", async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        { metadata: { source: "book", book_id: "5", chunk_index: "0" } },
        { metadata: { source: "book:pdf:qwen-ocr", book_id: 5, chunk_index: 1 } },
      ],
    });
    const refs = await findBookChunkDocIds({ query } as any, "tenant-a");

    expect(refs).toEqual([
      { docId: "book_5_chunk_0", bookId: 5, chunkIndex: 0 },
      { docId: "book_5_chunk_1", bookId: 5, chunkIndex: 1 },
    ]);
  });

  it("SQLはsource LIKE 'book%'でテナント絞り込みをかける(非FAQチャンクの誤爆を防ぐ)", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await findBookChunkDocIds({ query } as any, "tenant-a");

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("source' LIKE 'book%'");
    expect(params).toEqual(["tenant-a"]);
  });

  it("book_id/chunk_indexが数値化できない行は無視する(不正データでクラッシュしない)", async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ metadata: { source: "book", book_id: "not-a-number", chunk_index: "0" } }],
    });
    const refs = await findBookChunkDocIds({ query } as any, "tenant-a");
    expect(refs).toEqual([]);
  });
});

describe("copyBookDocsToNewIndex", () => {
  it("旧indexが存在しない(初回同期)場合、対象0件ならcopied=0で成功扱い", async () => {
    const result = await copyBookDocsToNewIndex("http://es.test:9200", null, "faq_t1_123", []);
    expect(result).toEqual({ expected: 0, copied: 0, missing: [] });
  });

  it("旧indexが存在しないのに対象があれば全件missingとして報告する(想定外の状態を隠さない)", async () => {
    const result = await copyBookDocsToNewIndex(
      "http://es.test:9200",
      null,
      "faq_t1_123",
      [{ docId: "book_1_chunk_0", bookId: 1, chunkIndex: 0 }],
    );
    expect(result).toEqual({ expected: 1, copied: 0, missing: ["book_1_chunk_0"] });
  });

  it("mget→bulkで旧indexのドキュメントを新indexへ実体コピーする", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    global.fetch = jest.fn(async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).includes("_mget")) {
        return {
          ok: true,
          json: async () => ({
            docs: [
              { _id: "book_1_chunk_0", found: true, _source: { question: "Q", answer: "A", source: "book" } },
              { _id: "book_1_chunk_1", found: false },
            ],
          }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({ errors: false }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await copyBookDocsToNewIndex(
      "http://es.test:9200",
      "faq_t1",
      "faq_t1_999",
      [
        { docId: "book_1_chunk_0", bookId: 1, chunkIndex: 0 },
        { docId: "book_1_chunk_1", bookId: 1, chunkIndex: 1 },
      ],
    );

    expect(result).toEqual({ expected: 2, copied: 1, missing: ["book_1_chunk_1"] });
    expect(calls[0]!.url).toContain("/faq_t1/_mget");
    expect(calls[1]!.url).toContain("/_bulk");
    expect(calls[1]!.body).toContain('"_index":"faq_t1_999"');
    expect(calls[1]!.body).toContain('"_id":"book_1_chunk_0"');
    expect(calls[1]!.body).not.toContain("book_1_chunk_1");
  });

  it("bulkの一部ドキュメントがエラーならcopiedから除く", async () => {
    global.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes("_mget")) {
        return {
          ok: true,
          json: async () => ({
            docs: [
              { _id: "book_1_chunk_0", found: true, _source: {} },
              { _id: "book_1_chunk_1", found: true, _source: {} },
            ],
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          errors: true,
          items: [{ index: {} }, { index: { error: { type: "mapper_parsing_exception" } } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await copyBookDocsToNewIndex(
      "http://es.test:9200",
      "faq_t1",
      "faq_t1_999",
      [
        { docId: "book_1_chunk_0", bookId: 1, chunkIndex: 0 },
        { docId: "book_1_chunk_1", bookId: 1, chunkIndex: 1 },
      ],
    );

    expect(result.expected).toBe(2);
    expect(result.copied).toBe(1);
  });

  it("_mget が非200ならエラーを投げる(黙って0件扱いにしない)", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error",
    })) as unknown as typeof fetch;

    await expect(
      copyBookDocsToNewIndex("http://es.test:9200", "faq_t1", "faq_t1_999", [
        { docId: "book_1_chunk_0", bookId: 1, chunkIndex: 0 },
      ]),
    ).rejects.toThrow(/_mget failed/);
  });
});
