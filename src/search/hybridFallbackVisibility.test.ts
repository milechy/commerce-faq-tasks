// src/search/hybridFallbackVisibility.test.ts
//
// 情報漏洩 P1 (2026-08-30):
// 言語別インデックスが 404 のときに走る ES フォールバック検索
// (hybrid.ts の `faq_${tenantId}` フォールバック) が tenant_id フィルタのみで、
// 非公開 (is_published=false) や検索除外 (is_excluded_from_search=true) にした FAQ が
// 匿名訪問者 (widget) の回答に混入し得た。
//
// 本テストは fake ES で ES bool クエリのフィルタを実際に評価し、
//   1) フォールバック経路でも非公開/検索除外 FAQ が結果から除外されること
//   2) 主経路とフォールバック経路で可視性挙動が一致すること
//   3) 書籍チャンク (is_published フィールドを持たない) は over-block されないこと
// を検証する。

const searchMock = jest.fn();

jest.mock("@elastic/elasticsearch", () => ({
  Client: jest.fn().mockImplementation(() => ({ search: searchMock })),
}));

jest.mock("../lib/crypto/textEncrypt", () => ({
  decryptText: (s: string) => s,
}));

jest.mock("../lib/db", () => ({ pool: null }));

jest.mock("./langIndex", () => ({
  toSupportedLang: (v: unknown) => v ?? "ja",
  // 言語別インデックスをプライマリ、旧形式をフォールバックとして返す
  resolveFallbackIndices: (t: string) => [`faq_${t}_ja`, `faq_${t}`],
  DEFAULT_LANG: "ja",
}));

// --- fake ES: bool クエリのフィルタ節を実際に評価する ------------------------

type Doc = {
  id: string;
  tenant_id: string;
  text: string;
  is_published?: boolean;
  is_excluded_from_search?: boolean;
};

// 検証用コーパス。すべて tenant-1 所属。
const CORPUS: Doc[] = [
  { id: "pub", tenant_id: "tenant-1", is_published: true, is_excluded_from_search: false, text: "公開FAQ: 送料は無料です" },
  { id: "draft", tenant_id: "tenant-1", is_published: false, is_excluded_from_search: false, text: "内部メモ(下書き): 社外秘の原価情報" },
  { id: "excluded", tenant_id: "tenant-1", is_published: true, is_excluded_from_search: true, text: "検索除外設定: 旧価格の告知文" },
  // 書籍チャンク: is_published / is_excluded_from_search フィールドを持たない
  { id: "book", tenant_id: "tenant-1", text: "書籍チャンク: 心理学の原則" },
];

const asArr = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

function matchesClause(clause: any, doc: Doc): boolean {
  if (clause.bool) return matchesBool(clause.bool, doc);
  if (clause.term) {
    const [field, value] = Object.entries(clause.term)[0] as [string, unknown];
    return (doc as any)[field] === value;
  }
  if (clause.exists) return (doc as any)[clause.exists.field] !== undefined;
  if (clause.multi_match) return true; // 全文一致は本テストでは常にマッチ扱い
  throw new Error(`unsupported clause: ${JSON.stringify(clause)}`);
}

function matchesBool(bool: any, doc: Doc): boolean {
  if (bool.must !== undefined && !asArr(bool.must).every((c) => matchesClause(c, doc))) return false;
  if (bool.filter !== undefined && !asArr(bool.filter).every((c) => matchesClause(c, doc))) return false;
  if (bool.must_not !== undefined && asArr(bool.must_not).some((c) => matchesClause(c, doc))) return false;
  if (bool.should !== undefined) {
    const mss = bool.minimum_should_match ?? 1;
    const cnt = asArr(bool.should).filter((c) => matchesClause(c, doc)).length;
    if (cnt < mss) return false;
  }
  return true;
}

function evalSearch(query: any) {
  const hits = CORPUS.filter((d) => matchesClause(query, d)).map((d) => ({
    _id: d.id,
    _source: { text: d.text },
    _score: 1.0,
  }));
  return { hits: { hits } };
}

// --- helpers ----------------------------------------------------------------

function loadHybridSearch() {
  let mod: any;
  jest.isolateModules(() => {
    mod = require("./hybrid");
  });
  return mod.hybridSearch as (
    q: string,
    tenantId?: string,
    lang?: unknown,
    excludedIds?: string[]
  ) => Promise<{ items: { id: string; text: string; source: string }[]; note?: string }>;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env["ES_URL"] = "http://localhost:9200";
  // フォールバック分岐 (LANG_SEARCH_ENABLED && 404) を有効化するためモジュール読込前に設定
  process.env["LANG_SEARCH_ENABLED"] = "1";
});

afterEach(() => {
  delete process.env["ES_URL"];
  delete process.env["LANG_SEARCH_ENABLED"];
});

describe("hybridSearch — ES フォールバック経路の可視性フィルタ", () => {
  it("言語別インデックスが404のとき、フォールバック検索でも非公開/検索除外FAQを除外する", async () => {
    // プライマリ(言語別 = faq_tenant-1_ja,...) は 404 → フォールバック(faq_tenant-1)へ
    searchMock.mockImplementation(async ({ index, query }: { index: string; query: any }) => {
      if (index.includes("_ja")) {
        const err: any = new Error("index_not_found_exception");
        err.meta = { statusCode: 404 };
        throw err;
      }
      return evalSearch(query);
    });

    const hybridSearch = loadHybridSearch();
    const result = await hybridSearch("送料について", "tenant-1");

    const ids = result.items.map((it) => it.id).sort();
    // 公開FAQと書籍チャンクのみ。下書き・検索除外は出ない。
    expect(ids).toEqual(["book", "pub"]);
    expect(result.items.some((it) => it.id === "draft")).toBe(false);
    expect(result.items.some((it) => it.id === "excluded")).toBe(false);
    // フォールバック経路を実際に通ったことを確認
    expect(result.note).toContain("es_lang_fallback:faq_tenant-1");
  });

  it("フォールバッククエリは主経路と同一の可視性フィルタ節(is_published / is_excluded_from_search)を含む", async () => {
    searchMock.mockImplementation(async ({ index, query }: { index: string; query: any }) => {
      if (index.includes("_ja")) {
        const err: any = new Error("index_not_found_exception");
        err.meta = { statusCode: 404 };
        throw err;
      }
      return evalSearch(query);
    });

    const hybridSearch = loadHybridSearch();
    await hybridSearch("送料について", "tenant-1");

    // 2回目の呼び出し = フォールバック検索
    const fallbackArgs = searchMock.mock.calls[1]![0];
    const asJson = JSON.stringify(fallbackArgs.query);
    expect(asJson).toContain("is_published");
    expect(asJson).toContain("is_excluded_from_search");
    // tenant スコープは維持されている
    expect(asJson).toContain("tenant_id");
  });

  it("主経路(言語別インデックス成功時)とフォールバック経路で可視結果が一致する", async () => {
    // 主経路成功パターン
    searchMock.mockImplementation(async ({ query }: { query: any }) => evalSearch(query));
    const hybridPrimary = loadHybridSearch();
    const primary = await hybridPrimary("送料について", "tenant-1");
    const primaryIds = primary.items.map((it) => it.id).sort();

    jest.clearAllMocks();

    // フォールバックパターン
    searchMock.mockImplementation(async ({ index, query }: { index: string; query: any }) => {
      if (index.includes("_ja")) {
        const err: any = new Error("index_not_found_exception");
        err.meta = { statusCode: 404 };
        throw err;
      }
      return evalSearch(query);
    });
    const hybridFallback = loadHybridSearch();
    const fallback = await hybridFallback("送料について", "tenant-1");
    const fallbackIds = fallback.items.map((it) => it.id).sort();

    expect(fallbackIds).toEqual(primaryIds);
    expect(fallbackIds).toEqual(["book", "pub"]);
  });

  it("書籍チャンク(is_publishedフィールドなし)はフォールバック経路で over-block されない", async () => {
    searchMock.mockImplementation(async ({ index, query }: { index: string; query: any }) => {
      if (index.includes("_ja")) {
        const err: any = new Error("index_not_found_exception");
        err.meta = { statusCode: 404 };
        throw err;
      }
      return evalSearch(query);
    });

    const hybridSearch = loadHybridSearch();
    const result = await hybridSearch("心理学", "tenant-1");

    expect(result.items.some((it) => it.id === "book")).toBe(true);
  });
});
