// src/lib/book-pipeline/pipeline.test.ts
// Phase44: 書籍チャンク構造化パイプライン テスト (10件)

import { splitIntoChunks } from "./chunkSplitter";
import { structurizeChunks } from "./structurizer";
import { embedAndStore } from "./embedAndStore";
import { runBookPipeline } from "./pipeline";
import type { PageText } from "./pdfExtractor";

// ── モック ────────────────────────────────────────────────────────────────

// pdfExtractor をモック
jest.mock("./pdfExtractor", () => ({
  extractPdfText: jest.fn(),
}));
import { extractPdfText } from "./pdfExtractor";
const mockExtractPdfText = extractPdfText as jest.MockedFunction<typeof extractPdfText>;

// Groq クライアントをモック
jest.mock("../../agent/llm/groqClient", () => ({
  groqClient: {
    call: jest.fn().mockResolvedValue(
      JSON.stringify({
        category: "テスト",
        summary: "テスト要約",
        keywords: ["kw1", "kw2"],
        question: "テスト質問",
        answer: "テスト回答",
        confidence: 0.9,
      })
    ),
  },
}));

// encryptText をモック（平文返し）
jest.mock("../crypto/textEncrypt", () => ({
  encryptText: (t: string) => t,
}));

// ── ヘルパー ──────────────────────────────────────────────────────────────

function makePages(text: string, pageNumber = 1): PageText[] {
  return [{ pageNumber, text }];
}

function makeLongText(chars: number): string {
  return "あ".repeat(chars);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(overrides: { queryFn?: (sql: string, params?: any[]) => Promise<unknown> } = {}) {
  const rows: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queryFn = overrides.queryFn ?? ((_sql: string, _params?: any[]) =>
    Promise.resolve({ rows, rowCount: 0 })
  );
  return { query: jest.fn(queryFn) };
}

// ── テスト ────────────────────────────────────────────────────────────────

describe("chunkSplitter", () => {
  test("1: 500文字未満のテキストは1チャンクにまとまる", () => {
    const pages = makePages("あ".repeat(300));
    const chunks = splitIntoChunks(pages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].pageNumber).toBe(1);
  });

  test("2: 1200文字のテキストは複数チャンクに分割される", () => {
    const pages = makePages("い".repeat(1200));
    const chunks = splitIntoChunks(pages);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000 + 100); // overlap + max
    }
  });

  test("3: 段落区切りで優先的に分割される", () => {
    const para1 = "あ".repeat(600);
    const para2 = "い".repeat(600);
    const pages = makePages(`${para1}\n\n${para2}`);
    const chunks = splitIntoChunks(pages);
    // 各段落が独立したチャンクになるはず
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("4: 空のページリストは空配列を返す", () => {
    expect(splitIntoChunks([])).toHaveLength(0);
  });

  test("5: チャンクにオーバーラップが含まれる（前チャンク末尾100文字）", () => {
    const text = "あ".repeat(600) + "い".repeat(600);
    const pages = makePages(text);
    const chunks = splitIntoChunks(pages);
    if (chunks.length >= 2) {
      const endOfFirst = chunks[0].text.slice(-100);
      expect(chunks[1].text.startsWith(endOfFirst)).toBe(true);
    }
  });
});

describe("structurizer", () => {
  test("6: Groq レスポンスが正しくパースされる", async () => {
    const chunks = splitIntoChunks(makePages("あ".repeat(600)));
    const results = await structurizeChunks(chunks);
    expect(results).toHaveLength(chunks.length);
    expect(results[0].category).toBe("テスト");
    expect(results[0].question).toBe("テスト質問");
    expect(results[0].answer).toBe("テスト回答");
    expect(results[0].confidence).toBe(0.9);
  });

  test("7: Groq が無効なJSONを返してもフォールバックする", async () => {
    const { groqClient } = await import("../../agent/llm/groqClient");
    (groqClient.call as jest.Mock).mockResolvedValueOnce("invalid json response");
    const chunks = splitIntoChunks(makePages("あ".repeat(600)));
    const results = await structurizeChunks(chunks);
    expect(results[0].category).toBe("その他");
    expect(results[0].confidence).toBe(0);
  });
});

describe("embedAndStore", () => {
  test("8: faq_embeddings に正しく INSERT される", async () => {
    const { groqClient } = await import("../../agent/llm/groqClient");
    (groqClient.call as jest.Mock).mockResolvedValue(
      JSON.stringify({
        category: "テスト",
        summary: "要約",
        keywords: [],
        question: "Q",
        answer: "A",
        confidence: 0.8,
      })
    );
    const chunks = splitIntoChunks(makePages("あ".repeat(600)));
    const structured = await structurizeChunks(chunks);

    const insertRows = [{ id: 1 }];
    const db = makeDb({
      queryFn: (sql: string) => {
        if (sql.includes("INSERT INTO faq_embeddings")) {
          return Promise.resolve({ rows: insertRows });
        }
        return Promise.resolve({ rows: [] });
      },
    });

    const ids = await embedAndStore("tenant-a", 1, structured, {
      db: db as any,
      embedFn: async () => Array(1536).fill(0.1),
    });

    expect(ids).toHaveLength(structured.length);
    const insertCall = db.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO faq_embeddings")
    );
    expect(insertCall).toBeDefined();
    // metadata に source: book が含まれるか (params[3])
    const metaArg = (insertCall as unknown[])[1] as unknown[];
    expect(metaArg[3] as string).toContain('"source":"book"');
  });
});

describe("runBookPipeline", () => {
  test("9: 正常フローで status が embedded になる", async () => {
    mockExtractPdfText.mockResolvedValue({
      pages: [{ pageNumber: 1, text: "あ".repeat(600) }],
      pageCount: 1,
    });

    const statusUpdates: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = makeDb({
      queryFn: (sql: string, params?: any[]) => {
        if (sql.includes("SELECT") && sql.includes("book_uploads")) {
          return Promise.resolve({
            rows: [{
              id: 42,
              tenant_id: "tenant-a",
              storage_path: "tenant-a/test.pdf.enc",
              encryption_iv: null,
              status: "uploaded",
            }],
          });
        }
        if (sql.includes("UPDATE book_uploads")) {
          const status = params?.[1] as string;
          statusUpdates.push(status);
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("INSERT INTO faq_embeddings")) {
          return Promise.resolve({ rows: [{ id: 1 }] });
        }
        return Promise.resolve({ rows: [] });
      },
    });

    const { groqClient } = await import("../../agent/llm/groqClient");
    (groqClient.call as jest.Mock).mockResolvedValue(
      JSON.stringify({ category: "テスト", summary: "要約", keywords: [], question: "Q", answer: "A", confidence: 0.9 })
    );

    const mockSupabase = {} as any; // extractPdfText はモック済みなので不使用

    const result = await runBookPipeline(42, {
      db: db as any,
      supabase: mockSupabase,
      embedAndStoreDeps: { embedFn: async () => Array(1536).fill(0.1) },
    });

    expect(result.pageCount).toBe(1);
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
    expect(statusUpdates).toContain("processing");
    expect(statusUpdates).toContain("chunked");
    expect(statusUpdates).toContain("embedded");
  });

  test("10: book_uploads が見つからない場合はエラーをスローする", async () => {
    const db = makeDb({
      queryFn: () => Promise.resolve({ rows: [] }),
    });

    await expect(
      runBookPipeline(999, { db: db as any })
    ).rejects.toThrow("not found");
  });
});
