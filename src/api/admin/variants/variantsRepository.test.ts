// src/api/admin/variants/variantsRepository.test.ts
// PR-3: getVariantStats のsource='user'絞り込みと、母数不足(会話0件)時に
// avg_score を 0 ではなく null で返すこと(CLAUDE.md 禁止34)の検証。

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { getVariantStats } from "./variantsRepository";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("getVariantStats", () => {
  it("variantが1件も無ければDBに問い合わせず空配列を返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ system_prompt_variants: [] }] });

    const result = await getVariantStats("tenant-a", 30);

    expect(result).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1); // listVariantsの1回のみ
  });

  it("集計クエリにsource='user'絞り込みが入っている", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ system_prompt_variants: [{ id: "v1", name: "標準", prompt: "p", weight: 100 }] }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await getVariantStats("tenant-a", 30);

    const [statsSql] = mockQuery.mock.calls[1]!;
    expect(statsSql).toContain("cs.metadata->>'source' = 'user'");
  });

  it("会話が0件(統計行なし)のvariantはavg_score:null・conversation_count:0を返す(0ではなくnull)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ system_prompt_variants: [{ id: "v1", name: "標準", prompt: "p", weight: 100 }] }],
      })
      .mockResolvedValueOnce({ rows: [] }); // 統計クエリの結果が空(GROUP BYで行が無い)

    const result = await getVariantStats("tenant-a", 30);

    expect(result).toEqual([
      { id: "v1", name: "標準", weight: 100, avg_score: null, conversation_count: 0 },
    ]);
  });

  it("評価が1件もついていないvariant(AVG(score)がSQL上でNULL)もavg_score:nullを返す", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ system_prompt_variants: [{ id: "v1", name: "標準", prompt: "p", weight: 100 }] }],
      })
      .mockResolvedValueOnce({
        rows: [{ prompt_variant_id: "v1", avg_score: null, conversation_count: "3" }],
      });

    const result = await getVariantStats("tenant-a", 30);

    expect(result[0]).toEqual({
      id: "v1",
      name: "標準",
      weight: 100,
      avg_score: null,
      conversation_count: 3,
    });
  });

  it("評価が付いているvariantは実数のavg_scoreを返す", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ system_prompt_variants: [{ id: "v1", name: "標準", prompt: "p", weight: 100 }] }],
      })
      .mockResolvedValueOnce({
        rows: [{ prompt_variant_id: "v1", avg_score: "82.5", conversation_count: "10" }],
      });

    const result = await getVariantStats("tenant-a", 30);

    expect(result[0]).toEqual({
      id: "v1",
      name: "標準",
      weight: 100,
      avg_score: 82.5,
      conversation_count: 10,
    });
  });
});
