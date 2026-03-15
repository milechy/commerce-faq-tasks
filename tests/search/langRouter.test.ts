// tests/search/langRouter.test.ts
// Phase33 C: langRouter ユニットテスト（外部依存なし）
//
// ES / pgvector は未設定の環境でテストするため、
// 実際のネットワーク呼び出しは発生しない。
// 各ブランチのロジック（no_embedding, not_configured）を確認する。

import { langRouterSearch } from "../../src/search/langRouter";

describe("langRouterSearch", () => {
  const baseParams = {
    query: "返品したいのですが",
    tenantId: "tenant1",
  };

  beforeEach(() => {
    // ES_URL, DATABASE_URL が未設定の状態でテスト
    delete process.env.ES_URL;
    delete process.env.DATABASE_URL;
  });

  it("ES/PG が未設定の場合は空リストを返す", async () => {
    const result = await langRouterSearch(baseParams);
    expect(result.items).toEqual([]);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("lang が未指定の場合は ja をデフォルトとする", async () => {
    const result = await langRouterSearch(baseParams);
    expect(result.lang).toBe("ja");
  });

  it("lang=en を正しく解決する", async () => {
    const result = await langRouterSearch({ ...baseParams, lang: "en" });
    expect(result.lang).toBe("en");
  });

  it("不正な lang は DEFAULT_LANG (ja) にフォールバックする", async () => {
    const result = await langRouterSearch({ ...baseParams, lang: "zh" });
    expect(result.lang).toBe("ja");
  });

  it("embedding なしの場合は pgvector:no_embedding を note に含む", async () => {
    const result = await langRouterSearch(baseParams);
    expect(result.note).toContain("pgvector:no_embedding");
  });

  it("空の embedding は pgvector:no_embedding を note に含む", async () => {
    const result = await langRouterSearch({ ...baseParams, embedding: [] });
    expect(result.note).toContain("pgvector:no_embedding");
  });

  it("ms フィールドは数値である", async () => {
    const result = await langRouterSearch(baseParams);
    expect(typeof result.ms).toBe("number");
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("items は配列である", async () => {
    const result = await langRouterSearch(baseParams);
    expect(Array.isArray(result.items)).toBe(true);
  });
});
