-- Phase77: サイトマップFAQ発見(GID 1218167748520497) — クロール除外パターン
-- excluded_page_patterns(ウィジェット非表示ページ)とは別の概念:
-- こちらは discover_faq_urls_from_sitemap がFAQ候補URLを拾わないページを指定する。
-- 実行は DBA/人間 が行う（コードは適用済みを前提として実装）
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS faq_crawl_exclude_patterns TEXT[] NOT NULL DEFAULT '{}';
