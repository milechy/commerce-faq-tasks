// src/search/excludedIds.test.ts
// Phase69-2: excluded_ids ゼロ知識検索テスト
import fs from "fs";
import path from "path";
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

// --- pgvector.ts: source-aware exclusion (Phase69-2 Round 3, Codex #1 対応) ---
//
// pgvector.ts は widget chat / dialog (searchTool 経由) で使われる主検索パス。
// Codex Adversarial Round 2 #1: legacy embedding without faq_id metadata が
// fd.id IS NULL pass-through で FAQ exclusion をすり抜ける問題への対応。
//
// 対応方針 (Option C): source 判定で FAQ 系 / 非 FAQ 系を分離
//   - FAQ 系 (scrape/text/faq) → faq_docs 厳格チェック (fd.id IS NOT NULL 必須)
//   - 非 FAQ 系 (book/web/groq, source NULL) → faq_embeddings.is_excluded_from_search のみ
//
// 静的 SQL 検証 (本番 SQL は Postgres 側評価のため、SQL 文字列に必要句が含まれることで確認)

describe("pgvector.ts SQL: source-aware exclusion (Phase69-2 Round 3)", () => {
  const filePath = path.resolve(__dirname, "pgvector.ts");
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(filePath, "utf8");
  });

  it("FAQ 系 source (scrape/text/faq) を IN 句で限定する", () => {
    expect(source).toMatch(/fe\.metadata->>'source'\s+IN\s+\(\s*'scrape'\s*,\s*'text'\s*,\s*'faq'\s*\)/);
  });

  it("FAQ 系では fd.id IS NOT NULL を要求する (legacy 未連携 embedding を除外)", () => {
    // FAQ 系ブロック内で fd.id IS NOT NULL が現れることを確認
    const faqBlockMatch = source.match(
      /fe\.metadata->>'source'\s+IN\s+\(\s*'scrape'\s*,\s*'text'\s*,\s*'faq'\s*\)[\s\S]{0,400}/
    );
    expect(faqBlockMatch).not.toBeNull();
    expect(faqBlockMatch![0]).toMatch(/fd\.id IS NOT NULL/);
    expect(faqBlockMatch![0]).toMatch(/fd\.is_published\s*=\s*true/);
    expect(faqBlockMatch![0]).toMatch(/fd\.is_excluded_from_search/);
  });

  it("非 FAQ 系 (source NULL or NOT IN リスト) は OR ブランチで faq_docs チェックをスキップ", () => {
    expect(source).toMatch(/fe\.metadata->>'source'\s+IS\s+NULL/);
    expect(source).toMatch(/fe\.metadata->>'source'\s+NOT\s+IN\s+\(\s*'scrape'\s*,\s*'text'\s*,\s*'faq'\s*\)/);
  });

  it("faq_embeddings 直接の is_excluded_from_search フィルターは維持される (全 source 共通)", () => {
    expect(source).toMatch(/fe\.is_excluded_from_search IS NULL OR fe\.is_excluded_from_search\s*=\s*false/);
  });

  it("JOIN ON 句に numeric guard (~ '^[0-9]+$') が入る (非数値 faq_id での bigint キャスト失敗を防ぐ)", () => {
    // LEFT JOIN ブロック内に numeric guard が含まれることを確認
    const joinBlockMatch = source.match(/left join faq_docs fd[\s\S]{0,300}/);
    expect(joinBlockMatch).not.toBeNull();
    expect(joinBlockMatch![0]).toMatch(/fe\.metadata->>'faq_id'\s*~\s*'\^\[0-9\]\+\$'/);
  });

  it("tenant 分離フィルター (fe.tenant_id = $1 OR fe.tenant_id = 'global') は維持される", () => {
    expect(source).toMatch(/fe\.tenant_id\s*=\s*\$1\s+OR\s+fe\.tenant_id\s*=\s*'global'/);
  });
});

// --- pgvector.ts: 実 SQL 実行系テスト (pool.query をモックして bind/結果マッピングを検証) ---

describe("pgvector.ts: searchPgVector runtime behavior (Phase69-2 Round 3)", () => {
  const origDbUrl = process.env.DATABASE_URL;
  let capturedSql: string | null = null;
  let capturedParams: unknown[] | null = null;

  beforeAll(() => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  });

  afterAll(() => {
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    capturedSql = null;
    capturedParams = null;
    jest.resetModules();
    jest.doMock("../lib/db", () => ({
      pool: {
        query: jest.fn((sql: string, params: unknown[]) => {
          capturedSql = sql;
          capturedParams = params;
          return Promise.resolve({ rows: [] });
        }),
      },
    }));
  });

  afterEach(() => {
    jest.dontMock("../lib/db");
  });

  it("SQL の bind params に tenantId, embedding literal, topK が含まれる (順序維持)", async () => {
    const { searchPgVector } = await import("./pgvector");
    await searchPgVector({
      tenantId: "tenantA",
      embedding: [0.1, 0.2, 0.3],
      topK: 5,
    });
    expect(capturedParams).not.toBeNull();
    expect(capturedParams![0]).toBe("tenantA");
    expect(capturedParams![1]).toBe("[0.1,0.2,0.3]");
    expect(capturedParams![2]).toBe(5);
  });

  it("excludedIds 指定時は SQL に != ALL($4::text[]) 句が追加され、bind 4番目に配列が渡る", async () => {
    const { searchPgVector } = await import("./pgvector");
    await searchPgVector({
      tenantId: "tenantA",
      embedding: [0.5, 0.6],
      excludedIds: ["e1", "e2"],
    });
    expect(capturedSql).toMatch(/fe\.id::text\s*!=\s*ALL\(\$4::text\[\]\)/);
    expect(capturedParams![3]).toEqual(["e1", "e2"]);
  });

  it("excludedIds 空の場合は SQL に != ALL 句が現れない (動的句なし)", async () => {
    const { searchPgVector } = await import("./pgvector");
    await searchPgVector({
      tenantId: "tenantA",
      embedding: [0.5, 0.6],
      excludedIds: [],
    });
    expect(capturedSql).not.toMatch(/!=\s*ALL\(\$4/);
    expect(capturedParams).toHaveLength(3);
  });

  it("実行 SQL に source 判定の OR ブランチ両方が含まれる", async () => {
    const { searchPgVector } = await import("./pgvector");
    await searchPgVector({
      tenantId: "tenantA",
      embedding: [0.1],
    });
    expect(capturedSql).toMatch(/fe\.metadata->>'source'\s+IN\s+\(\s*'scrape'\s*,\s*'text'\s*,\s*'faq'\s*\)/);
    expect(capturedSql).toMatch(/fe\.metadata->>'source'\s+NOT\s+IN\s+\(\s*'scrape'\s*,\s*'text'\s*,\s*'faq'\s*\)/);
    expect(capturedSql).toMatch(/fd\.id IS NOT NULL/);
  });
});
