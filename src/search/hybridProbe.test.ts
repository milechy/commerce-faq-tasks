// src/search/hybridProbe.test.ts
//
// ナレッジ配線是正 P2 (Asana GID 1217811043892649):
// ES が0件のとき、固定クエリ「返品 送料」で索引の生死を確認するプローブが
// 診断のはずが、そのヒットを検索結果(esHits)として差し替えてしまい、
// ユーザーの質問と無関係なFAQが回答の根拠に混入していた。
// .claude/rules/knowledge.md 参照。

const searchMock = jest.fn();

jest.mock("@elastic/elasticsearch", () => ({
  Client: jest.fn().mockImplementation(() => ({ search: searchMock })),
}));

jest.mock("../lib/crypto/textEncrypt", () => ({
  decryptText: (s: string) => s,
}));

jest.mock("../lib/db", () => ({ pool: null }));

jest.mock("./langIndex", () => ({
  toSupportedLang: (v: unknown) => v,
  resolveFallbackIndices: () => ["faq_tenant-1"],
  DEFAULT_LANG: "ja",
}));

import { hybridSearch } from "./hybrid";

const EMPTY_ES_RESULT = { hits: { hits: [] } };

function esResultWithHits(n: number) {
  return {
    hits: {
      hits: Array.from({ length: n }, (_, i) => ({
        _id: `probe-${i}`,
        _source: { text: "返品・送料についてのFAQ" },
        _score: 1.0,
      })),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env["ES_URL"] = "http://localhost:9200";
});

afterEach(() => {
  delete process.env["ES_URL"];
});

describe("hybridSearch — ES 0件時の固定クエリプローブ", () => {
  it("プローブがヒットしても items は空のまま(無関係な結果を回答に混入させない)", async () => {
    // 1回目: 実クエリの検索 → 0件。2回目: プローブ「返品 送料」→ ヒットあり
    searchMock.mockResolvedValueOnce(EMPTY_ES_RESULT).mockResolvedValueOnce(esResultWithHits(3));

    const result = await hybridSearch("全く関係ない質問", "tenant-1");

    expect(result.items.filter((it: { source: string }) => it.source === "es")).toHaveLength(0);
  });

  it("プローブがヒットしたとき notes に index_alive を記録する(診断用)", async () => {
    searchMock.mockResolvedValueOnce(EMPTY_ES_RESULT).mockResolvedValueOnce(esResultWithHits(2));

    const result = await hybridSearch("全く関係ない質問", "tenant-1");

    expect(result.note).toContain("probe:index_alive_query_missed");
  });

  it("プローブも0件のとき notes に index_empty_or_down を記録する", async () => {
    searchMock.mockResolvedValueOnce(EMPTY_ES_RESULT).mockResolvedValueOnce(EMPTY_ES_RESULT);

    const result = await hybridSearch("全く関係ない質問", "tenant-1");

    expect(result.note).toContain("probe:index_empty_or_down");
  });

  it("プローブの検索クエリは固定文字列「返品 送料」を使う(実クエリと混同しない)", async () => {
    searchMock.mockResolvedValueOnce(EMPTY_ES_RESULT).mockResolvedValueOnce(EMPTY_ES_RESULT);

    await hybridSearch("全く関係ない質問", "tenant-1");

    const secondCallArgs = searchMock.mock.calls[1]![0];
    expect(JSON.stringify(secondCallArgs.query)).toContain("返品 送料");
  });

  it("回帰: 実クエリがヒットすればプローブは呼ばれず、実ヒットがそのまま返る", async () => {
    searchMock.mockResolvedValueOnce({
      hits: { hits: [{ _id: "real-1", _source: { text: "送料は無料です" }, _score: 2.0 }] },
    });

    const result = await hybridSearch("送料について", "tenant-1");

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(result.items.some((it: { text: string }) => it.text === "送料は無料です")).toBe(true);
  });
});
