// src/agent/tools/synthesisTool.faqQaSeparation.test.ts
//
// ナレッジ配線是正 P16 (Asana GID 1217811006160990):
// synthesisTool.ts の参考FAQ組み立てが `Q: ${excerpt}` `A: ${excerpt}` と
// 同一の切り詰め済みテキストを2回並べており、質問文と回答文の区別が失われ、
// 限られたコンテキストを二重に消費していた。metadata.faq_id を持つヒットは
// faq_docs から question/answer を個別に引き直し、持たないヒット
// (book/OCR/learned_memory)は存在しない質問文を捏造せず「参考情報」の
// 1ブロックとして渡すことを固定する。

import { synthesizeAnswer } from "./synthesisTool";
import { groqClient } from "../llm/groqClient";
import { getPool } from "../../lib/db";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn(), callWithUsage: jest.fn() },
}));

jest.mock("../../lib/db", () => ({ getPool: jest.fn() }));

const TENANTS_ROW = { system_prompt: null, system_prompt_variants: [], recorded_variant_id: null };

function mockPool(opts: {
  faqDocsRows?: Array<{ id: number; question: string; answer: string }>;
  captureFaqDocsParams?: (params: unknown[]) => void;
}) {
  const query = jest.fn().mockImplementation((sql: string, params: unknown[]) => {
    if (sql.includes("FROM tuning_rules")) return Promise.resolve({ rows: [] });
    if (sql.includes("FROM tenants")) return Promise.resolve({ rows: [TENANTS_ROW] });
    if (sql.includes("FROM faq_docs")) {
      opts.captureFaqDocsParams?.(params);
      return Promise.resolve({ rows: opts.faqDocsRows ?? [] });
    }
    return Promise.resolve({ rows: [] });
  });
  (getPool as jest.Mock).mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env["GROQ_API_KEY"] = "test-groq-key";
  process.env["GAP_DETECTION_ENABLED"] = "false";
  (groqClient.callWithUsage as jest.Mock).mockResolvedValue({
    content: "回答",
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});

afterEach(() => {
  delete process.env["GROQ_API_KEY"];
  delete process.env["GAP_DETECTION_ENABLED"];
});

async function userPromptOf(input: Parameters<typeof synthesizeAnswer>[0]) {
  await synthesizeAnswer(input);
  const call = (groqClient.callWithUsage as jest.Mock).mock.calls[0]![0];
  return call.messages.find((m: { role: string }) => m.role === "user").content as string;
}

describe("buildFaqContext(synthesisTool.ts) — Q/Aの分離", () => {
  it("faq_id を持つヒットは faq_docs から引いた question/answer が別々の値で入る", async () => {
    mockPool({
      faqDocsRows: [{ id: 101, question: "保証期間はどのくらいですか", answer: "3ヶ月保証です" }],
    });

    const userMessage = await userPromptOf({
      query: "保証について教えてください",
      items: [{ id: "faq-101", text: "duplicated excerpt text", score: 0.9, source: "es", metadata: { faq_id: 101 } }],
      tenantId: "tenant-1",
    });

    expect(userMessage).toContain("Q: 保証期間はどのくらいですか");
    expect(userMessage).toContain("A: 3ヶ月保証です");
    // 是正対象のバグの回帰: QとAが同一文字列にならない
    expect(userMessage).not.toContain("duplicated excerpt text");
  });

  it("faq_id を持たないヒット(book/OCR等)はQ/A形式にならず「参考情報」の1ブロックになる", async () => {
    mockPool({});

    const userMessage = await userPromptOf({
      query: "この本の内容について",
      items: [{ id: "book-1", text: "書籍からの抜粋テキスト", score: 0.8, source: "es", metadata: { source: "book" } }],
      tenantId: "tenant-1",
    });

    expect(userMessage).toContain("参考情報: 書籍からの抜粋テキスト");
    expect(userMessage).not.toMatch(/Q: /);
    expect(userMessage).not.toMatch(/A: /);
  });

  it("faq_id はあるがfaq_docsに実体が見つからない(削除済み等)場合も参考情報にフォールバックする", async () => {
    mockPool({ faqDocsRows: [] });

    const userMessage = await userPromptOf({
      query: "質問",
      items: [{ id: "faq-999", text: "元の抜粋", score: 0.9, source: "es", metadata: { faq_id: 999 } }],
      tenantId: "tenant-1",
    });

    expect(userMessage).toContain("参考情報: 元の抜粋");
  });

  it("回帰: 抜粋の文字数上限(RAG_EXCERPT_MAX_CHARS)がQ/Aそれぞれに従来どおり効く", async () => {
    const longQuestion = "あ".repeat(300);
    const longAnswer = "い".repeat(300);
    mockPool({ faqDocsRows: [{ id: 101, question: longQuestion, answer: longAnswer }] });

    const userMessage = await userPromptOf({
      query: "質問",
      items: [{ id: "faq-101", text: "excerpt", score: 0.9, source: "es", metadata: { faq_id: 101 } }],
      tenantId: "tenant-1",
    });

    // RAG_EXCERPT_MAX_CHARS=200。省略記号込みでそれ以下に収まっていること。
    const qLine = userMessage.split("\n").find((l) => l.startsWith("Q: "))!;
    const aLine = userMessage.split("\n").find((l) => l.startsWith("A: "))!;
    expect(qLine.length).toBeLessThanOrEqual(200 + "Q: ".length);
    expect(aLine.length).toBeLessThanOrEqual(200 + "A: ".length);
    expect(qLine).not.toBe(`Q: ${longQuestion}`);
  });

  it("上位3件(RAG_MAX_EXCERPTS)を超えるヒットがあっても、faq_docsクエリは上位3件のfaq_idだけを対象にする", async () => {
    let captured: unknown[] = [];
    mockPool({
      faqDocsRows: [
        { id: 1, question: "Q1", answer: "A1" },
        { id: 2, question: "Q2", answer: "A2" },
        { id: 3, question: "Q3", answer: "A3" },
      ],
      captureFaqDocsParams: (params) => {
        captured = params;
      },
    });

    await userPromptOf({
      query: "質問",
      items: [
        { id: "faq-1", text: "e1", score: 0.9, source: "es", metadata: { faq_id: 1 } },
        { id: "faq-2", text: "e2", score: 0.8, source: "es", metadata: { faq_id: 2 } },
        { id: "faq-3", text: "e3", score: 0.7, source: "es", metadata: { faq_id: 3 } },
        { id: "faq-4", text: "e4", score: 0.6, source: "es", metadata: { faq_id: 4 } },
        { id: "faq-5", text: "e5", score: 0.5, source: "es", metadata: { faq_id: 5 } },
      ],
      tenantId: "tenant-1",
    });

    expect(captured[0]).toBe("tenant-1");
    expect(captured[1]).toEqual([1, 2, 3]);
  });

  it("faq_docsへの問い合わせはfaq_id込みのヒットが1件もなければ発生しない", async () => {
    const query = mockPool({});

    await userPromptOf({
      query: "質問",
      items: [{ id: "book-1", text: "書籍抜粋", score: 0.9, source: "es", metadata: { source: "book" } }],
      tenantId: "tenant-1",
    });

    const faqDocsCalls = query.mock.calls.filter(([sql]: [string]) => sql.includes("FROM faq_docs"));
    expect(faqDocsCalls).toHaveLength(0);
  });
});
