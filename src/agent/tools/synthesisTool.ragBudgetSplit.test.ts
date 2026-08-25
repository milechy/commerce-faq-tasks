// src/agent/tools/synthesisTool.ragBudgetSplit.test.ts
//
// ナレッジ配線是正 P18 (Asana GID 1217811237352427):
// 「1件200字・最大3件」は書籍由来チャンクの著作権保護のために導入した制約
// (buildFaqContext のコメント参照)だが、これまで出所を問わず全チャンクに
// 一律適用しており、テナント自身のFAQも1回答あたり600字しか根拠として
// 渡せなかった。出所別に別枠(ragLimits.ts の BOOK_ 系 / FAQ_ 系)を持つことで、
// 書籍の著作権保護(最重要・緩めてはならない)を維持しつつ、テナント自身の
// FAQ・learned_memoryはより多くの情報量を根拠にできることを固定する。

import { synthesizeAnswer } from "./synthesisTool";
import { groqClient } from "../llm/groqClient";
import { getPool } from "../../lib/db";
import {
  BOOK_EXCERPT_MAX_CHARS,
  BOOK_MAX_EXCERPTS,
  FAQ_EXCERPT_MAX_CHARS,
  FAQ_MAX_EXCERPTS,
} from "../config/ragLimits";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn(), callWithUsage: jest.fn() },
}));

jest.mock("../../lib/db", () => ({ getPool: jest.fn() }));

function mockPool(faqDocsRows: Array<{ id: number; question: string; answer: string }> = []) {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes("FROM tuning_rules")) return Promise.resolve({ rows: [] });
    if (sql.includes("FROM tenants")) {
      return Promise.resolve({ rows: [{ system_prompt: null, system_prompt_variants: [], recorded_variant_id: null }] });
    }
    if (sql.includes("FROM faq_docs")) return Promise.resolve({ rows: faqDocsRows });
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

async function userPromptOf(items: any[]) {
  await synthesizeAnswer({ query: "質問", items, tenantId: "tenant-1" });
  const call = (groqClient.callWithUsage as jest.Mock).mock.calls[0]![0];
  return call.messages.find((m: { role: string }) => m.role === "user").content as string;
}

/**
 * userPrompt テンプレート(`参考FAQ:\n${faqContext}\n上記の...`)から faqContext
 * 部分だけを取り出す。末尾ブロックが後続の案内文と同じ `\n\n` 区切りではないため、
 * 単純な `.split("\n\n")` だと末尾ブロックに案内文まで混入する。
 */
function extractFaqContext(userMessage: string): string {
  const start = userMessage.indexOf("参考FAQ:\n") + "参考FAQ:\n".length;
  const end = userMessage.indexOf("\n上記のFAQ情報をもとに");
  return userMessage.slice(start, end);
}

describe("buildFaqContext — 出所別のRAG予算(ナレッジ配線是正P18)", () => {
  it("【最重要・著作権保護の回帰】書籍チャンクは何件混ざっていても200字/3件を超えない", async () => {
    // 意図的にリテラル値(200字・3件)で検証する。ragLimits.tsからimportした
    // 定数と比較すると、BOOK_EXCERPT_MAX_CHARS自体が緩められたときにテストが
    // 追従して緩んでしまい、著作権ガードの後退を検知できなくなる
    // (噛み確認で「書籍予算を緩めて赤くなること」を要求しているのはこのため)。
    mockPool();
    const bookItems = Array.from({ length: 6 }, (_, i) => ({
      id: `book-${i}`,
      text: "書".repeat(600),
      score: 0.9 - i * 0.01,
      source: "es" as const,
      metadata: { source: "book" },
    }));

    const userMessage = await userPromptOf(bookItems);

    const referenceLines = extractFaqContext(userMessage).split("\n\n").filter((b) => b.includes("参考情報:"));
    expect(referenceLines.length).toBeLessThanOrEqual(3);
    for (const block of referenceLines) {
      const excerpt = block.split("参考情報: ")[1] ?? "";
      expect(excerpt.length).toBeLessThanOrEqual(200);
    }
  });

  it("FAQ由来チャンクは新しい予算(FAQ_MAX_EXCERPTS件・FAQ_EXCERPT_MAX_CHARS字)まで渡される", async () => {
    const faqDocsRows = Array.from({ length: FAQ_MAX_EXCERPTS }, (_, i) => ({
      id: i + 1,
      question: `質問${i + 1}`.repeat(200),
      answer: `回答${i + 1}`.repeat(200),
    }));
    mockPool(faqDocsRows);
    const faqItems = Array.from({ length: FAQ_MAX_EXCERPTS + 2 }, (_, i) => ({
      id: `faq-${i}`,
      text: "excerpt",
      score: 0.9 - i * 0.01,
      source: "es" as const,
      metadata: { faq_id: i + 1 },
    }));

    const userMessage = await userPromptOf(faqItems);

    const faqBlocks = extractFaqContext(userMessage).split("\n\n").filter((b) => /^FAQ\d+:/.test(b));
    expect(faqBlocks.length).toBe(FAQ_MAX_EXCERPTS);
    const qLine = userMessage.split("\n").find((l) => l.startsWith("Q: "))!;
    expect(qLine.length).toBeGreaterThan(BOOK_EXCERPT_MAX_CHARS + "Q: ".length);
    expect(qLine.length).toBeLessThanOrEqual(FAQ_EXCERPT_MAX_CHARS + "Q: ".length);
  });

  it("書籍とFAQが混在するとき、書籍側だけが200字に切り詰められ、FAQ側は500字まで許される", async () => {
    mockPool([{ id: 1, question: "質".repeat(400), answer: "答".repeat(400) }]);

    const userMessage = await userPromptOf([
      { id: "faq-1", text: "excerpt", score: 0.95, source: "es", metadata: { faq_id: 1 } },
      { id: "book-1", text: "書".repeat(400), score: 0.9, source: "es", metadata: { source: "book" } },
    ]);

    const qLine = userMessage.split("\n").find((l) => l.startsWith("Q: "))!;
    const bookBlock = extractFaqContext(userMessage).split("\n\n").find((b) => b.includes("参考情報:"))!;
    const bookExcerpt = bookBlock.split("参考情報: ")[1] ?? "";

    expect(qLine.length - "Q: ".length).toBeGreaterThan(BOOK_EXCERPT_MAX_CHARS);
    expect(bookExcerpt.length).toBeLessThanOrEqual(BOOK_EXCERPT_MAX_CHARS);
  });

  it("壊れやすいポイント: 書籍とFAQが順位順に交互に並んでいても、各バケツは全体の先頭何件かではなく出所ごとの上位を独立に選ぶ", async () => {
    // ランク順: FAQ1(top) → BOOK1 → FAQ2 → BOOK2 → FAQ3 → BOOK3 → FAQ4 → BOOK4(4件目の書籍。溢れる)
    mockPool([
      { id: 1, question: "Q1", answer: "A1" },
      { id: 2, question: "Q2", answer: "A2" },
      { id: 3, question: "Q3", answer: "A3" },
      { id: 4, question: "Q4", answer: "A4" },
    ]);

    const userMessage = await userPromptOf([
      { id: "faq-1", text: "e1", score: 0.95, source: "es", metadata: { faq_id: 1 } },
      { id: "book-1", text: "書1", score: 0.9, source: "es", metadata: { source: "book" } },
      { id: "faq-2", text: "e2", score: 0.85, source: "es", metadata: { faq_id: 2 } },
      { id: "book-2", text: "書2", score: 0.8, source: "es", metadata: { source: "book" } },
      { id: "faq-3", text: "e3", score: 0.75, source: "es", metadata: { faq_id: 3 } },
      { id: "book-3", text: "書3", score: 0.7, source: "es", metadata: { source: "book" } },
      { id: "faq-4", text: "e4", score: 0.65, source: "es", metadata: { faq_id: 4 } },
      { id: "book-4", text: "書4", score: 0.6, source: "es", metadata: { source: "book" } },
    ]);

    const context = extractFaqContext(userMessage);
    // 全4件のFAQ(FAQ_MAX_EXCERPTS=5未満なので全件)が採用される
    for (const q of ["Q1", "Q2", "Q3", "Q4"]) expect(context).toContain(q);
    // 書籍は先頭からBOOK_MAX_EXCERPTS=3件のみ。4件目(book-4、全体では最下位)は溢れて出ない
    expect(context).toContain("書1");
    expect(context).toContain("書2");
    expect(context).toContain("書3");
    expect(context).not.toContain("書4");
  });

  it("OCR由来チャンク(metadata.source='book:pdf:qwen-ocr')も書籍として200字/3件の予算で扱われる", async () => {
    mockPool();
    const ocrItems = Array.from({ length: 5 }, (_, i) => ({
      id: `ocr-${i}`,
      text: "書".repeat(600),
      score: 0.9 - i * 0.01,
      source: "es" as const,
      metadata: { source: "book:pdf:qwen-ocr" },
    }));

    const userMessage = await userPromptOf(ocrItems);

    const referenceLines = extractFaqContext(userMessage).split("\n\n").filter((b) => b.includes("参考情報:"));
    expect(referenceLines.length).toBeLessThanOrEqual(BOOK_MAX_EXCERPTS);
    for (const block of referenceLines) {
      const excerpt = block.split("参考情報: ")[1] ?? "";
      expect(excerpt.length).toBeLessThanOrEqual(BOOK_EXCERPT_MAX_CHARS);
    }
  });

  it("環境変数を新設していない(禁止41): ragLimits.tsの値は全て静的定数で決まる", () => {
    expect(BOOK_EXCERPT_MAX_CHARS).toBe(200);
    expect(BOOK_MAX_EXCERPTS).toBe(3);
    expect(typeof FAQ_EXCERPT_MAX_CHARS).toBe("number");
    expect(typeof FAQ_MAX_EXCERPTS).toBe("number");
  });
});
