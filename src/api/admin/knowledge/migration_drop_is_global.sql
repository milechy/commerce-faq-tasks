-- ナレッジ配線是正 P19 (2026-08-25): faq_docs.is_global は完全な死列。
-- Phase52e(migration_add_is_global.sql)で追加されたが、読み手も書き手も
-- コード上に存在しない(admin-ui のテストフィクスチャにのみ残存していた。
-- 本PRで除去済み)。
--
-- 実際のグローバル知識(全テナント共通)の仕組みは
-- faq_docs.tenant_id = 'global' / 'r2c_docs' であり、is_global 列とは無関係
-- (src/search/pgvectorSearch.ts)。この列を残すと、将来「is_global を使えば
-- グローバル化できる」という誤った実装を招く。
--
-- コードからの参照は本PRで全て除去済み(grep で0件)。
--
-- 適用は自動実行しない(CLAUDE.md 禁止8)。人間が運用作業として適用すること。
-- 適用前に、本番の faq_docs.is_global が実際に使われていない
-- (true の行が無い、またはあっても意図しない)ことを確認すること:
--   SELECT COUNT(*) FROM faq_docs WHERE is_global = true;

DROP INDEX IF EXISTS idx_faq_docs_is_global;
ALTER TABLE faq_docs DROP COLUMN IF EXISTS is_global;
