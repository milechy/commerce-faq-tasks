-- migration_book_schema.sql
-- Phase50: book_uploads テーブルに LLM コンテンツ種類判定カラムを追加
-- 実行環境: VPS PostgreSQL (psql または Supabase SQL Editor)
-- 依存: book_uploads テーブルが存在すること（Phase47 で作成済み）

ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS content_type TEXT;
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS content_type_label TEXT;
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS suggested_schema JSONB;
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS schema_confidence NUMERIC(3,2);
ALTER TABLE book_uploads ADD COLUMN IF NOT EXISTS schema_reasoning TEXT;
