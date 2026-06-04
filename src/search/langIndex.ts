// src/search/langIndex.ts
// Phase33 C: 言語別ESインデックス名解決
//
// インデックス命名規則:
//   faq_{tenantId}_{lang}  — 言語別インデックス (新形式)
//   faq_{tenantId}         — 旧形式 (後方互換)

export type SupportedLang = "ja" | "en";

export const DEFAULT_LANG: SupportedLang = "ja";

/**
 * クエリ言語に対応するプライマリESインデックス名を返す。
 * 言語別インデックスが存在しない場合のフォールバックは resolveFallbackIndices を使う。
 */
export function resolveEsIndex(tenantId: string, lang: SupportedLang): string {
  return `faq_${tenantId}_${lang}`;
}

/**
 * FAQ の ES 書き込み先インデックス名を解決する（テナント別）。
 *
 * Phase69-2-E: write path と read path の index 名不整合（Phase33-c 起因）を解消するための
 * 単一の正典関数。read path（hybrid.ts / langRouter.ts の resolveFallbackIndices）も
 * 同じ `faq_${tenantId}` 命名規則を使うため、upsert/delete/exclude の全 write 経路は
 * 必ずこの関数で index 名を解決すること。
 *
 * 命名規則の正典は SCRIPTS/sync-es.ts（reindex）と一致: `faq_${tenantId}`。
 * 環境変数 ES_FAQ_INDEX による上書きは廃止（read path がテナント別 index を前提とするため）。
 */
export function resolveFaqWriteIndex(tenantId: string): string {
  return `faq_${tenantId}`;
}

/**
 * 言語別インデックスが存在しないテナントのためのフォールバックリスト。
 * 先頭から順に試行し、最初にヒットしたものを使う想定。
 */
export function resolveFallbackIndices(
  tenantId: string,
  lang: SupportedLang
): string[] {
  return [
    `faq_${tenantId}_${lang}`, // プライマリ（言語別）
    `faq_${tenantId}`,         // 旧形式（後方互換）
  ];
}

/**
 * 文字列が SupportedLang かどうかを判定する型ガード。
 */
export function isSupportedLang(v: unknown): v is SupportedLang {
  return v === "ja" || v === "en";
}

/**
 * 任意の値を SupportedLang に変換する。
 * 不正な値の場合は DEFAULT_LANG を返す。
 */
export function toSupportedLang(v: unknown): SupportedLang {
  if (isSupportedLang(v)) return v;
  return DEFAULT_LANG;
}
