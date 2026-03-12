// src/search/langEmbedding.ts
// Phase33 C: 言語判定 + 言語別embedding格納
//
// FAQ登録・更新時にテキストの言語を判定し、
// 言語別にESインデックスとpgvectorテーブルへ格納するためのユーティリティ。

import { SupportedLang, DEFAULT_LANG, isSupportedLang } from "./langIndex";

// ひらがな: U+3041–U+3096
const HIRAGANA_RE = /[\u3041-\u3096]/;
// カタカナ: U+30A1–U+30FC
const KATAKANA_RE = /[\u30A1-\u30FC]/;
// CJK統合漢字: U+4E00–U+9FFF (基本), U+3400–U+4DBF (拡張A), U+F900–U+FAFF (互換)
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;

/**
 * テキストのUnicode範囲から言語を推定する軽量判定（外部API不使用）。
 *
 * 判定ロジック:
 * - ひらがな / カタカナ / CJK漢字が含まれていれば "ja"
 * - それ以外は "en"
 */
export function detectLangFromText(text: string): SupportedLang {
  if (!text || text.trim().length === 0) return DEFAULT_LANG;

  if (HIRAGANA_RE.test(text) || KATAKANA_RE.test(text) || CJK_RE.test(text)) {
    return "ja";
  }
  return "en";
}

/**
 * FAQオブジェクトから使用すべき言語を解決する。
 *
 * 優先順位:
 * 1. FAQ に lang フィールドがあればそれを使用
 * 2. なければ text フィールドから自動検出
 * 3. 両方なければ DEFAULT_LANG
 */
export function resolveFaqLang(faq: {
  lang?: unknown;
  text?: string;
  question?: string;
  answer?: string;
}): SupportedLang {
  // 明示的な lang フィールドがある場合
  if (isSupportedLang(faq.lang)) {
    return faq.lang;
  }

  // text フィールドから自動検出
  const textForDetection =
    faq.text ||
    [faq.question, faq.answer].filter(Boolean).join(" ");

  if (textForDetection) {
    return detectLangFromText(textForDetection);
  }

  return DEFAULT_LANG;
}

/**
 * pgvector の faq_embeddings テーブルに lang カラムが存在するかを確認するための
 * ALTER TABLE SQL を返す（migration用）。
 *
 * 実際の migration 実行は docs/integration/backend_deps.md の指示に従い
 * 統合担当が行う。ここでは SQL 文字列の定義のみ行う。
 */
export const MIGRATION_ADD_LANG_COLUMN = `
-- Phase33 C: faq_embeddings に lang カラムを追加
-- 既に存在する場合はエラーになるため、IF NOT EXISTS 相当の確認が必要
ALTER TABLE faq_embeddings
  ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'ja';

-- lang によるフィルタリング用インデックス
CREATE INDEX IF NOT EXISTS faq_embeddings_lang_idx
  ON faq_embeddings(tenant_id, lang);
`.trim();
