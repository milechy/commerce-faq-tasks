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
