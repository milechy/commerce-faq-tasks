// src/agent/flow/searchAgent.dedup.test.ts
//
// ナレッジ配線是正 P3 (Asana GID 1217811006079789):
// runSearchAgent が pgvector を2回検索していた(1回目: pgvectorSearch.ts、
// 2回目: searchTool.ts 経由で pgvector.ts)。同じテナント・同じ embedding で
// 同じ行を引くため、embedTextWithUsage の呼び出しも2回になり、上位3件枠に
// 実質2チャンクしか入らない実害があった(.claude/rules/knowledge.md 参照)。
//
// 修正: ES(hybridSearch)は pgvector に1回目で0件だったときのみ呼ぶ
// (searchTool.ts が担っていたフォールバック専用の意味論を保つ)。
// pgvector を2回検索する経路が無くなったため、重複IDが構造的に発生しなくなる。

jest.mock("../../search/pgvectorSearch", () => ({ searchPgVector: jest.fn() }));
jest.mock("../llm/openaiEmbeddingClient", () => ({ embedTextWithUsage: jest.fn() }));
jest.mock("../memory/learnedMemoryRepository", () => ({
  createLearnedMemoryRepository: jest.fn(),
}));
jest.mock("../memory/featureFlag", () => ({
  isLearnedMemoryReadEnabled: jest.fn().mockReturnValue(false),
  getLearnedMemoryWeight: jest.fn().mockReturnValue(0.9),
}));
jest.mock("../tools/rerankTool", () => ({
  rerankTool: jest.fn().mockImplementation(({ items }: { items: unknown[] }) =>
    Promise.resolve({ items, rerankEngine: "heuristic", ce_ms: 0 }),
  ),
}));
jest.mock("../../search/hybrid", () => ({ hybridSearch: jest.fn() }));
jest.mock("../tools/synthesisTool", () => ({
  synthesizeAnswer: jest.fn().mockResolvedValue({
    answer: "回答",
    gapSignal: { hitCount: 0, topScore: 0 },
  }),
}));
jest.mock("../../api/events/behaviorContext", () => ({
  getBehaviorContext: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../api/events/similarUserMatcher", () => ({
  findSimilarPatterns: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../lib/db", () => ({ pool: null }));
jest.mock("../../lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));

import { runSearchAgent } from "./searchAgent";
import { searchPgVector } from "../../search/pgvectorSearch";
import { embedTextWithUsage } from "../llm/openaiEmbeddingClient";
import { hybridSearch } from "../../search/hybrid";

const mockedSearchPgVector = searchPgVector as jest.MockedFunction<typeof searchPgVector>;
const mockedEmbed = embedTextWithUsage as jest.MockedFunction<typeof embedTextWithUsage>;
const mockedHybridSearch = hybridSearch as jest.MockedFunction<typeof hybridSearch>;

const PG_HIT = { id: "faq-1", text: "送料は500円です", score: 0.9, source: "pgvector" as const, metadata: {} };

beforeEach(() => {
  jest.clearAllMocks();
  mockedEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3], totalTokens: 12, model: "text-embedding-3-small" });
});

describe("runSearchAgent — pgvector 重複検索の解消", () => {
  it("embedTextWithUsage は1ターンにつき1回だけ呼ばれる", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [PG_HIT], ms: 5 });

    await runSearchAgent({ q: "送料について", tenantId: "tenant-1" });

    expect(mockedEmbed).toHaveBeenCalledTimes(1);
  });

  it("pgvector にヒットがあれば ES(hybridSearch)は呼ばれない", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [PG_HIT], ms: 5 });

    await runSearchAgent({ q: "送料について", tenantId: "tenant-1" });

    expect(mockedHybridSearch).not.toHaveBeenCalled();
  });

  it("pgvector に同じヒットが重複して現れない(2回目の検索が無いため構造的に重複しない)", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [PG_HIT], ms: 5 });

    const result = await runSearchAgent({ q: "送料について", tenantId: "tenant-1" });

    const faqIds = (result.ragSources ?? []).map((s) => s.chunk_id);
    expect(faqIds.filter((id) => id === "faq-1")).toHaveLength(1);
  });

  it("回帰: pgvector が0件のときは ES(hybridSearch)が呼ばれ、その結果が使われる", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [], ms: 5 });
    mockedHybridSearch.mockResolvedValue({
      items: [{ id: "es-1", text: "ESからのヒット", score: 0.8, source: "es" as const }],
      ms: 30,
      note: "es_hits=1",
    });

    const result = await runSearchAgent({ q: "全く別の質問", tenantId: "tenant-1" });

    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    const faqIds = (result.ragSources ?? []).map((s) => s.chunk_id);
    expect(faqIds).toContain("es-1");
  });

  it("回帰: pgvector も ES も0件なら ragSources は空", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [], ms: 5 });
    mockedHybridSearch.mockResolvedValue({ items: [], ms: 10, note: "es_hits=0" });

    const result = await runSearchAgent({ q: "全く別の質問", tenantId: "tenant-1" });

    expect(result.ragSources).toEqual([]);
  });

  it("ナレッジ配線是正P9: source='book:pdf:qwen-ocr'(OCR由来)もragSourcesでbook扱いになる(faqへの誤ラベル防止)", async () => {
    mockedSearchPgVector.mockResolvedValue({
      items: [
        {
          id: "ocr-1",
          text: "OCRチャンク",
          score: 0.9,
          source: "pgvector" as const,
          metadata: { source: "book:pdf:qwen-ocr", page: 3 },
        },
      ],
      ms: 5,
    });

    const result = await runSearchAgent({ q: "書籍の質問", tenantId: "tenant-1" });

    const ocrSource = (result.ragSources ?? []).find((s) => s.chunk_id === "ocr-1");
    expect(ocrSource?.source).toBe("book");
  });

  it("回帰: source='faq'や未設定はfaq扱いのまま(startsWith緩和で誤って全てbookにならない)", async () => {
    mockedSearchPgVector.mockResolvedValue({
      items: [
        { id: "faq-1", text: "FAQチャンク", score: 0.9, source: "pgvector" as const, metadata: { source: "faq" } },
        { id: "faq-2", text: "旧データ", score: 0.8, source: "pgvector" as const },
      ],
      ms: 5,
    });

    const result = await runSearchAgent({ q: "普通の質問", tenantId: "tenant-1" });

    const sources = result.ragSources ?? [];
    expect(sources.find((s) => s.chunk_id === "faq-1")?.source).toBe("faq");
    expect(sources.find((s) => s.chunk_id === "faq-2")?.source).toBe("faq");
  });
});

// PR-2(2026-08-25収益監査): embeddingTokens が chat モデルの prompt_tokens に
// 誤って合算されており(かつ embedTextWithUsage 自身も別途 tenant_id='unknown' の
// 行を作っていた)、二重計上になっていた。
describe("runSearchAgent — embedding usage の分離計上 (PR-2)", () => {
  it("embedTextWithUsage は skipTracking:true で呼ばれる(unknown行を作らせない)", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [PG_HIT], ms: 5 });

    await runSearchAgent({ q: "送料について", tenantId: "tenant-1" });

    expect(mockedEmbed).toHaveBeenCalledWith("送料について", { skipTracking: true });
  });

  it("llmUsage.prompt_tokensにembeddingトークンを合算しない(chatモデルのレートで誤課金しない)", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [PG_HIT], ms: 5 });
    const { synthesizeAnswer } = jest.requireMock("../tools/synthesisTool") as {
      synthesizeAnswer: jest.Mock;
    };
    synthesizeAnswer.mockResolvedValueOnce({
      answer: "回答",
      gapSignal: { hitCount: 0, topScore: 0 },
      llmUsage: { prompt_tokens: 100, completion_tokens: 30 },
    });

    const result = await runSearchAgent({ q: "送料について", tenantId: "tenant-1" });

    // embedding分(12トークン)が混ざらず、synthesisの実トークンのみ
    expect(result.llmUsage).toEqual({ prompt_tokens: 100, completion_tokens: 30 });
  });

  it("embeddingUsageを実モデル名・実トークン数で別途返す", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [PG_HIT], ms: 5 });
    mockedEmbed.mockResolvedValue({ embedding: [0.1], totalTokens: 12, model: "text-embedding-3-small" });

    const result = await runSearchAgent({ q: "送料について", tenantId: "tenant-1" });

    expect(result.embeddingUsage).toEqual({ model: "text-embedding-3-small", totalTokens: 12 });
  });

  it("embeddingが0トークン(テストモード等)ならembeddingUsageはundefined", async () => {
    mockedSearchPgVector.mockResolvedValue({ items: [PG_HIT], ms: 5 });
    mockedEmbed.mockResolvedValue({ embedding: [0.1], totalTokens: 0, model: "text-embedding-3-small" });

    const result = await runSearchAgent({ q: "送料について", tenantId: "tenant-1" });

    expect(result.embeddingUsage).toBeUndefined();
  });

  it("pgvector検索が失敗してembeddingが取得できなかった場合もクラッシュせずembeddingUsageはundefined", async () => {
    mockedEmbed.mockRejectedValueOnce(new Error("openai down"));
    mockedHybridSearch.mockResolvedValue({ items: [], ms: 10, note: "es_hits=0" });

    const result = await runSearchAgent({ q: "送料について", tenantId: "tenant-1" });

    expect(result.embeddingUsage).toBeUndefined();
  });
});
