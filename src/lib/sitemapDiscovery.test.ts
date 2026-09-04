// src/lib/sitemapDiscovery.test.ts
import { lookup } from "node:dns/promises";
import {
  parseSitemapXml,
  filterUrlsByExcludePatterns,
  fetchSitemapUrls,
  discoverFaqCandidateUrls,
} from "./sitemapDiscovery";
import { logger } from "./logger";

jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(),
}));

const mockedLookup = lookup as unknown as jest.Mock;

/**
 * global.fetch と node:dns/promises の lookup をモックし、safeFetch/assertUrlAllowed
 * は実装のまま通す(=SSRFガードの配線自体を実地で検証するため、ガード側は
 * モックしない)。ホスト名は全て公開IPに解決させ、実ネットワークへは出ない。
 */
function mockPublicDns() {
  mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
}

function mockFetchResponses(byUrl: Record<string, { status?: number; body?: string } | "reject">) {
  const fetchMock = jest.fn(async (url: string) => {
    const entry = byUrl[url];
    if (entry === undefined) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    if (entry === "reject") {
      throw new Error("network error");
    }
    return new Response(entry.body ?? "", { status: entry.status ?? 200 });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = fetchMock;
  return fetchMock;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe("parseSitemapXml", () => {
  it("通常のurlsetサイトマップからURLを抽出する", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/faq</loc></url>
        <url><loc>https://example.com/products/1</loc></url>
      </urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.kind).toBe("urlset");
    expect(result.urls).toEqual([
      "https://example.com/",
      "https://example.com/faq",
      "https://example.com/products/1",
    ]);
  });

  it("sitemapindexは子サイトマップのURL一覧をkind:sitemapindexで返す", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-products.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
      </sitemapindex>`;
    const result = parseSitemapXml(xml);
    expect(result.kind).toBe("sitemapindex");
    expect(result.urls).toEqual([
      "https://example.com/sitemap-products.xml",
      "https://example.com/sitemap-pages.xml",
    ]);
  });

  it("XMLエンティティ(&amp;等)をデコードする", () => {
    const xml = `<urlset><url><loc>https://example.com/search?q=a&amp;b=c</loc></url></urlset>`;
    const result = parseSitemapXml(xml);
    expect(result.urls).toEqual(["https://example.com/search?q=a&b=c"]);
  });

  it("壊れたXML/該当ルート要素が無い場合はunknownで空配列を返す(例外を投げない)", () => {
    expect(parseSitemapXml("<not-a-sitemap>garbage</not-a-sitemap>")).toEqual({
      kind: "unknown",
      urls: [],
    });
    expect(parseSitemapXml("")).toEqual({ kind: "unknown", urls: [] });
    expect(parseSitemapXml("<urlset><url><loc>")).toEqual({
      kind: "urlset",
      urls: [],
    });
  });

  it("nullやundefinedが渡っても例外を投げない", () => {
    // @ts-expect-error 実行時の防御を検証する(呼び出し元がfetch結果を検証せず渡す場合がある)
    expect(parseSitemapXml(null)).toEqual({ kind: "unknown", urls: [] });
  });

  it("sitemap.xmlの代わりにHTML(ログイン/リダイレクトページ等)が返っても例外を投げずunknownを返す", () => {
    const html = `<!DOCTYPE html>
      <html><head><title>Login required</title></head>
      <body><form action="/login"><input name="user"></form></body></html>`;
    expect(parseSitemapXml(html)).toEqual({ kind: "unknown", urls: [] });
  });

  it("タグの対応が壊れたXMLでも例外を投げず、読み取れた<loc>だけを返す", () => {
    // </url> が閉じずに次の <url> が始まる、ルート閉じタグも欠落している壊れたXML。
    // 実装は正規表現でloc抽出するだけなのでタグの入れ子崩れの影響を受けない。
    const brokenXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/a</loc>
      <url><loc>https://example.com/b</loc></url>`;
    const result = parseSitemapXml(brokenXml);
    expect(result.kind).toBe("urlset");
    expect(result.urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("1000件超のURLを含む巨大なsitemapでも完了し、全件を漏れなく抽出する", () => {
    const count = 2500;
    const entries = Array.from(
      { length: count },
      (_, i) => `<url><loc>https://example.com/page-${i}</loc></url>`
    ).join("");
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
    const start = Date.now();
    const result = parseSitemapXml(xml);
    const elapsedMs = Date.now() - start;
    expect(result.kind).toBe("urlset");
    expect(result.urls).toHaveLength(count);
    expect(result.urls[0]).toBe("https://example.com/page-0");
    expect(result.urls[count - 1]).toBe(`https://example.com/page-${count - 1}`);
    // O(n^2)的な実装(配列の繰り返し結合等)であれば桁違いに遅くなるはずの規模。
    // 純粋なCPU処理のみで安定して速いことを大まかに確認する(厳密なベンチマークではない)。
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("filterUrlsByExcludePatterns", () => {
  const urls = [
    "https://example.com/faq",
    "https://example.com/products/1",
    "https://example.com/products/2",
    "https://example.com/privacy-policy",
    "https://example.com/blog/2026/09/post",
  ];

  it("パターン未指定なら全件そのまま返す", () => {
    expect(filterUrlsByExcludePatterns(urls, [])).toEqual(urls);
  });

  it("単一階層グロブ(*)にマッチするURLを除外する", () => {
    const result = filterUrlsByExcludePatterns(urls, ["/products/*"]);
    expect(result).not.toContain("https://example.com/products/1");
    expect(result).not.toContain("https://example.com/products/2");
    expect(result).toContain("https://example.com/faq");
  });

  it("完全一致パターンで単一ページを除外する", () => {
    const result = filterUrlsByExcludePatterns(urls, ["/privacy-policy"]);
    expect(result).not.toContain("https://example.com/privacy-policy");
    expect(result).toHaveLength(urls.length - 1);
  });

  it("複数階層グロブ(**)で配下すべてを除外する", () => {
    const result = filterUrlsByExcludePatterns(urls, ["/blog/**"]);
    expect(result).not.toContain("https://example.com/blog/2026/09/post");
  });

  it("URLとして解釈できない値は除外側に倒す", () => {
    const result = filterUrlsByExcludePatterns(["not-a-url", ...urls], ["/privacy-policy"]);
    expect(result).not.toContain("not-a-url");
  });
});

describe("fetchSitemapUrls (ネットワーク経由、safeFetchは実装のまま)", () => {
  beforeEach(() => {
    mockPublicDns();
  });

  it("sitemapindexが2件以上の子サイトマップを指す場合、全ての子のURLをマージして返す", async () => {
    mockFetchResponses({
      "https://example.com/sitemap.xml": {
        body: `<sitemapindex>
          <sitemap><loc>https://example.com/sitemap-products.xml</loc></sitemap>
          <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
        </sitemapindex>`,
      },
      "https://example.com/sitemap-products.xml": {
        body: `<urlset><url><loc>https://example.com/products/1</loc></url></urlset>`,
      },
      "https://example.com/sitemap-pages.xml": {
        body: `<urlset><url><loc>https://example.com/faq</loc></url></urlset>`,
      },
    });
    const urls = await fetchSitemapUrls("https://example.com/sitemap.xml");
    expect(urls.sort()).toEqual(["https://example.com/faq", "https://example.com/products/1"]);
  });

  it("同一URLが複数の子サイトマップに重複掲載されていても最終結果は重複除去される", async () => {
    mockFetchResponses({
      "https://example.com/sitemap.xml": {
        body: `<sitemapindex>
          <sitemap><loc>https://example.com/sitemap-a.xml</loc></sitemap>
          <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
        </sitemapindex>`,
      },
      "https://example.com/sitemap-a.xml": {
        body: `<urlset><url><loc>https://example.com/faq</loc></url></urlset>`,
      },
      "https://example.com/sitemap-b.xml": {
        // 同じURLが別の子サイトマップにも重複して載っているケース
        body: `<urlset><url><loc>https://example.com/faq</loc></url></urlset>`,
      },
    });
    const urls = await fetchSitemapUrls("https://example.com/sitemap.xml");
    expect(urls).toEqual(["https://example.com/faq"]);
  });

  it("子サイトマップの一部が404/失敗しても、取得できた他の子の分だけ返す(全滅にしない)", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockFetchResponses({
      "https://example.com/sitemap.xml": {
        body: `<sitemapindex>
          <sitemap><loc>https://example.com/sitemap-ok.xml</loc></sitemap>
          <sitemap><loc>https://example.com/sitemap-broken.xml</loc></sitemap>
        </sitemapindex>`,
      },
      "https://example.com/sitemap-ok.xml": {
        body: `<urlset><url><loc>https://example.com/faq</loc></url></urlset>`,
      },
      "https://example.com/sitemap-broken.xml": { status: 404, body: "not found" },
    });
    const urls = await fetchSitemapUrls("https://example.com/sitemap.xml");
    expect(urls).toEqual(["https://example.com/faq"]);
    warnSpy.mockRestore();
  });

  it("子サイトマップの取得が例外を投げても(タイムアウト等)、他の良好な子の発見を止めない", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockFetchResponses({
      "https://example.com/sitemap.xml": {
        body: `<sitemapindex>
          <sitemap><loc>https://example.com/sitemap-ok.xml</loc></sitemap>
          <sitemap><loc>https://example.com/sitemap-timeout.xml</loc></sitemap>
        </sitemapindex>`,
      },
      "https://example.com/sitemap-ok.xml": {
        body: `<urlset><url><loc>https://example.com/faq</loc></url></urlset>`,
      },
      "https://example.com/sitemap-timeout.xml": "reject",
    });
    const urls = await fetchSitemapUrls("https://example.com/sitemap.xml");
    expect(urls).toEqual(["https://example.com/faq"]);
    warnSpy.mockRestore();
  });

  it("入れ子のsitemapindex(2階層目)は辿らず無視するが、クラッシュや無限ループにはならない", async () => {
    // 孫サイトマップ(sitemap-should-not-be-fetched.xml)は意図的にレスポンスを
    // 登録せず、フェッチされたら即例外になるようにしておく — 万一実装が
    // 2階層目まで再帰してしまう回帰があれば、この例外で検出できる。
    const fetchMock = mockFetchResponses({
      "https://example.com/sitemap.xml": {
        body: `<sitemapindex>
          <sitemap><loc>https://example.com/sitemap-nested-index.xml</loc></sitemap>
          <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
        </sitemapindex>`,
      },
      // 子がさらにsitemapindexになっている(2階層目) — 実装は1階層までしか
      // 辿らない仕様なので、この子からのURLは失われるが、例外にはならず、
      // 兄弟の良好な子(sitemap-pages.xml)の発見は妨げない。
      "https://example.com/sitemap-nested-index.xml": {
        body: `<sitemapindex>
          <sitemap><loc>https://example.com/sitemap-should-not-be-fetched.xml</loc></sitemap>
        </sitemapindex>`,
      },
      "https://example.com/sitemap-pages.xml": {
        body: `<urlset><url><loc>https://example.com/faq</loc></url></urlset>`,
      },
    });
    const urls = await fetchSitemapUrls("https://example.com/sitemap.xml");
    expect(urls).toEqual(["https://example.com/faq"]);
    const fetchedUrls = fetchMock.mock.calls.map((call) => call[0]);
    expect(fetchedUrls).not.toContain("https://example.com/sitemap-should-not-be-fetched.xml");
  });

  it("サイトマップ自体が完全に取得失敗(全滅)した場合は空配列を返す", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockFetchResponses({ "https://example.com/sitemap.xml": { status: 500, body: "error" } });
    const urls = await fetchSitemapUrls("https://example.com/sitemap.xml");
    expect(urls).toEqual([]);
    warnSpy.mockRestore();
  });
});

describe("discoverFaqCandidateUrls の SSRFガード配線", () => {
  // ここでは safeFetch/assertUrlAllowed を一切モックしない。IPリテラルは
  // DNS解決を経ずに isBlockedIp で即座に判定されるため、決定的に検証できる。
  it.each([
    ["メタデータエンドポイント", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:8080/"],
    ["プライベートIP", "http://10.0.0.1/"],
  ])("baseUrlが内部/プライベートアドレス(%s)の場合、fetchを一切呼ばずに空配列を返す", async (_label, baseUrl) => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const fetchMock = mockFetchResponses({});
    const urls = await discoverFaqCandidateUrls(baseUrl);
    expect(urls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("localhostという表記(IPリテラルでない)でもDNS解決結果がloopbackならブロックしfetchしない", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockedLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchMock = mockFetchResponses({});
    const urls = await discoverFaqCandidateUrls("http://localhost:3000/");
    expect(urls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("公開ホストの場合は通常通りfetchされ、候補URLが返る(ガードが常時ブロックしているわけではないことの確認)", async () => {
    mockPublicDns();
    mockFetchResponses({
      "https://example.com/sitemap.xml": {
        body: `<urlset><url><loc>https://example.com/faq</loc></url></urlset>`,
      },
    });
    const urls = await discoverFaqCandidateUrls("https://example.com");
    expect(urls).toEqual(["https://example.com/faq"]);
  });
});
