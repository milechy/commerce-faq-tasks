// src/search/excludedIds.test.ts
// Phase69-2: excluded_ids ゼロ知識検索テスト
import { rerank, type Item } from "./rerank";
import { hybridSearch } from "./hybrid";

// --- rerank の excludedIds テスト ---

const makeItems = (...ids: string[]): Item[] =>
  ids.map((id, i) => ({
    id,
    text: `item ${id}`,
    score: 1 - i * 0.1,
    source: "es" as const,
  }));

describe("rerank: excludedIds", () => {
  it("除外IDがヒットしないこと", async () => {
    const items = makeItems("1", "2", "3", "4", "5");
    const result = await rerank("query", items, 5, ["2", "4"]);
    const ids = result.items.map((it) => it.id);
    expect(ids).not.toContain("2");
    expect(ids).not.toContain("4");
  });

  it("除外ID空配列はフィルターしないこと", async () => {
    const items = makeItems("1", "2", "3");
    const result = await rerank("query", items, 3, []);
    expect(result.items).toHaveLength(3);
  });

  it("除外IDがundefinedでもエラーにならないこと", async () => {
    const items = makeItems("1", "2", "3");
    const result = await rerank("query", items, 3, undefined);
    expect(result.items).toHaveLength(3);
  });

  it("全アイテムが除外された場合は空配列になること", async () => {
    const items = makeItems("1", "2");
    const result = await rerank("query", items, 5, ["1", "2"]);
    expect(result.items).toHaveLength(0);
  });

  it("テナント分離: excludedIds はリクエスト単位であり、別テナントの除外設定が混入しないこと", async () => {
    // テナントAの除外設定（["id-A"]）とテナントBの除外設定（["id-B"]）
    const tenantAItems = makeItems("id-A", "id-B", "id-C");
    const tenantBItems = makeItems("id-A", "id-B", "id-C");

    const resultA = await rerank("query", tenantAItems, 5, ["id-A"]);
    const resultB = await rerank("query", tenantBItems, 5, ["id-B"]);

    // テナントAでは id-A が除外され id-B は残る
    expect(resultA.items.map((it) => it.id)).not.toContain("id-A");
    expect(resultA.items.map((it) => it.id)).toContain("id-B");

    // テナントBでは id-B が除外され id-A は残る
    expect(resultB.items.map((it) => it.id)).not.toContain("id-B");
    expect(resultB.items.map((it) => it.id)).toContain("id-A");
  });
});

// --- hybridSearch の excludedIds テスト (ES_URL なし = モック不要) ---

describe("hybridSearch: excludedIds (ES_URL なし)", () => {
  const origEnv = process.env.ES_URL;

  beforeEach(() => {
    delete process.env.ES_URL;
  });

  afterEach(() => {
    if (origEnv !== undefined) process.env.ES_URL = origEnv;
    else delete process.env.ES_URL;
  });

  it("ES_URLなしでもexcludedIdsを渡してもエラーにならないこと", async () => {
    const result = await hybridSearch("test query", "tenant1", undefined, ["id1", "id2"]);
    expect(result.items).toBeInstanceOf(Array);
  });

  it("excludedIdsがnullish（undefined）でもエラーにならないこと", async () => {
    const result = await hybridSearch("test query", "tenant1", undefined, undefined);
    expect(result.items).toBeInstanceOf(Array);
  });

  it("excludedIdsが空配列でもエラーにならないこと", async () => {
    const result = await hybridSearch("test query", "tenant1", undefined, []);
    expect(result.items).toBeInstanceOf(Array);
  });
});
