// src/api/middleware/langDetect.ts
// Phase33: 言語検出ミドルウェア（外部API不使用・正規表現ベース）

import type { Lang } from "../i18n/messages";

const SUPPORTED_LANGS: ReadonlySet<string> = new Set<Lang>(["ja", "en"]);

/**
 * Accept-Language ヘッダから最初のサポート言語を取得する。
 * 例: "en-US,en;q=0.9,ja;q=0.8" → "en"
 */
function parseAcceptLanguage(header: string): Lang | null {
  // "lang[-region][;q=x]" の繰り返しをカンマ区切りで処理
  const parts = header.split(",");
  for (const part of parts) {
    const langTag = part.trim().split(";")[0].trim().toLowerCase();
    const primary = langTag.split("-")[0]; // "en-US" → "en"
    if (SUPPORTED_LANGS.has(primary)) {
      return primary as Lang;
    }
  }
  return null;
}

/**
 * リクエストから言語を判定するミドルウェア。
 *
 * 優先順位:
 *   1. クエリパラメータ: ?lang=ja
 *   2. ヘッダ: Accept-Language
 *   3. テナント設定のデフォルト言語 (req.tenantConfig?.defaultLang)
 *   4. フォールバック: "ja"
 *
 * 結果は req.lang に付与する。
 */
export function langDetectMiddleware(req: any, _res: any, next: any): void {
  // 1. クエリパラメータ
  const qLang =
    typeof req.query?.lang === "string" ? (req.query.lang as string).toLowerCase() : null;
  if (qLang && SUPPORTED_LANGS.has(qLang)) {
    req.lang = qLang as Lang;
    return next();
  }

  // 2. Accept-Language ヘッダ
  const acceptLang = req.headers?.["accept-language"];
  if (typeof acceptLang === "string") {
    const detected = parseAcceptLanguage(acceptLang);
    if (detected) {
      req.lang = detected;
      return next();
    }
  }

  // 3. テナント設定のデフォルト言語（存在する場合）
  const tenantConfig = req.tenantConfig as { defaultLang?: string } | undefined;
  if (tenantConfig?.defaultLang) {
    const tLang = tenantConfig.defaultLang.toLowerCase();
    if (SUPPORTED_LANGS.has(tLang)) {
      req.lang = tLang as Lang;
      return next();
    }
  }

  // 4. フォールバック
  req.lang = "ja" as Lang;
  next();
}
