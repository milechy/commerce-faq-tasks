// src/lib/sitemapDiscovery.ts
//
// サイトマップからFAQ取り込み候補URLを発見する(Phase 1: 発見のみ)。
// GID 1218167748520497。
//
// suggest_faq_import_from_urls(src/api/admin/agent/actionExecutor.ts)は
// テナント/LLMが手で挙げた1〜5件のURLからFAQ案を生成するツールで、こちらは
// その入力になる候補URLをsitemap.xmlから自動で洗い出すだけの、生成を一切
// 行わない読み取り専用の層。FAQの自動生成・自動公開はここでは行わない
// (2026-09-04: 自動生成した20件中8件を事後に削除する事故があったため、
// 人間の確認を経由しない生成・公開経路は意図的に作らない)。
//
// fetch(ネットワークI/O)とparse(純粋関数)を分離しているのは、parseを
// fixture文字列だけで単体テストできるようにするため。

import { safeFetch } from "./net/ssrfGuard";
import { matchesPathnameGlob } from "./excludedPagePattern";
import { logger } from "./logger";

export interface SitemapParseResult {
  kind: "urlset" | "sitemapindex" | "unknown";
  urls: string[];
}

const LOC_TAG_RE = /<loc>([\s\S]*?)<\/loc>/gi;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractLocs(xml: string): string[] {
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  LOC_TAG_RE.lastIndex = 0;
  while ((match = LOC_TAG_RE.exec(xml)) !== null) {
    const url = decodeXmlEntities(match[1]!.trim());
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * sitemap.xml のテキストを解析する純粋関数(ネットワークI/O無し)。
 * <urlset> と <sitemapindex> のどちらのルート要素かで kind を判定し、
 * いずれの場合も <loc> の中身をそのまま返す(呼び出し側が kind を見て、
 * sitemapindex なら子サイトマップとして再取得するかを決める)。
 * 壊れたXML/該当ルート要素が無い場合は kind: "unknown", urls: [] を返す
 * (例外は投げない)。
 */
export function parseSitemapXml(xml: string): SitemapParseResult {
  if (typeof xml !== "string" || xml.trim().length === 0) {
    return { kind: "unknown", urls: [] };
  }
  try {
    const isSitemapIndex = /<sitemapindex[\s>]/i.test(xml);
    const isUrlset = /<urlset[\s>]/i.test(xml);
    if (!isSitemapIndex && !isUrlset) {
      return { kind: "unknown", urls: [] };
    }
    const urls = extractLocs(xml);
    return { kind: isSitemapIndex ? "sitemapindex" : "urlset", urls };
  } catch {
    return { kind: "unknown", urls: [] };
  }
}

/**
 * URL群をexcludeパターン(グロブ、public/widget.jsのmatchPathnameGlobと同一構文)で
 * 絞り込む純粋関数。パターンはパス部分(pathname)に対して評価する
 * (excluded_page_patternsと揃える)。URLとして解釈できない値は除外側に倒す
 * (安全側: 判定できないURLをFAQ候補として残さない)。
 */
export function filterUrlsByExcludePatterns(urls: string[], excludePatterns: string[]): string[] {
  if (excludePatterns.length === 0) return [...urls];
  return urls.filter((url) => {
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    return !excludePatterns.some((pattern) => matchesPathnameGlob(pathname, pattern));
  });
}

const DEFAULT_TIMEOUT_MS = 10_000;
// 一部サイトマップにhttps->http混在等でloc内に同一ページが重複掲載されるため、
// 最終的な候補URLは重複除去する。
function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

async function fetchXml(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; R2C/1.0; +sitemap-discovery)" },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    logger.warn("[sitemapDiscovery] sitemap取得に失敗しました", { url, err: String(err) });
    return null;
  }
}

/**
 * sitemap.xml を取得しURL一覧を返す。sitemapindexの場合は子サイトマップを
 * 1階層だけ辿って展開する(入れ子のsitemapindexはそれ以上再帰しない —
 * 一般的なサイトマップ構成はこの1階層で十分)。子サイトマップの一部取得に
 * 失敗しても、取得できた分だけ返す(全滅時は空配列)。例外は投げない。
 */
export async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const xml = await fetchXml(sitemapUrl);
  if (!xml) return [];

  const parsed = parseSitemapXml(xml);
  if (parsed.kind === "urlset") {
    return dedupe(parsed.urls);
  }
  if (parsed.kind === "sitemapindex") {
    const childResults = await Promise.all(
      parsed.urls.map(async (childSitemapUrl) => {
        const childXml = await fetchXml(childSitemapUrl);
        if (!childXml) return [];
        const childParsed = parseSitemapXml(childXml);
        // 2階層目のsitemapindexは辿らない(仕様上「1階層のネストまで対応」で十分)。
        return childParsed.kind === "urlset" ? childParsed.urls : [];
      })
    );
    return dedupe(childResults.flat());
  }
  return [];
}

/**
 * テナントのサイトからFAQ取り込み候補URLを発見する(Phase 1の入口関数)。
 * baseUrl 直下の /sitemap.xml を対象とし、excludePatterns(テナントの
 * 恒常設定 + 呼び出し時の追加指定をマージ済みのもの)でパスを絞り込む。
 */
export async function discoverFaqCandidateUrls(
  baseUrl: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  let sitemapUrl: string;
  try {
    sitemapUrl = new URL("/sitemap.xml", baseUrl).toString();
  } catch {
    return [];
  }
  const urls = await fetchSitemapUrls(sitemapUrl);
  return filterUrlsByExcludePatterns(urls, excludePatterns);
}
