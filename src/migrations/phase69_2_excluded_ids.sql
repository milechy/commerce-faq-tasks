-- Phase69-2: excluded_ids ゼロ知識検索
-- 実行日: VPS で手動実行
-- 対象: VPS PostgreSQL (65.108.159.161)

-- ============================================================
-- 1. faq_embeddings に is_excluded_from_search カラム追加
--    検索クエリのフィルター対象（INDEX付き）
-- ============================================================

ALTER TABLE faq_embeddings
  ADD COLUMN IF NOT EXISTS is_excluded_from_search BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_faq_embeddings_excluded
  ON faq_embeddings (tenant_id, is_excluded_from_search)
  WHERE is_excluded_from_search = true;

-- ============================================================
-- 2. faq_docs に is_excluded_from_search カラム追加
--    Admin UI から操作する際のソース・オブ・トゥルース
-- ============================================================

ALTER TABLE faq_docs
  ADD COLUMN IF NOT EXISTS is_excluded_from_search BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_faq_docs_excluded
  ON faq_docs (tenant_id, is_excluded_from_search)
  WHERE is_excluded_from_search = true;

-- ============================================================
-- 3. tenants に default_excluded_ids カラム追加
--    テナント管理者がグローバル除外IDを設定可能に
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_excluded_ids TEXT[] DEFAULT '{}';

COMMENT ON COLUMN tenants.default_excluded_ids IS 'Phase69-2: テナントレベルのデフォルト除外ID一覧（faq_embeddings.id）';

-- ============================================================
-- 確認クエリ (実行後に手動確認)
-- ============================================================
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name IN ('faq_embeddings', 'faq_docs', 'tenants')
--   AND column_name IN ('is_excluded_from_search', 'default_excluded_ids')
-- ORDER BY table_name, column_name;
