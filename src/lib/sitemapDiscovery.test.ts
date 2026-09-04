// src/lib/sitemapDiscovery.test.ts
import { parseSitemapXml, filterUrlsByExcludePatterns } from "./sitemapDiscovery";

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
