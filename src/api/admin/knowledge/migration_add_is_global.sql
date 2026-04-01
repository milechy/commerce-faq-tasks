-- Phase52e: faq_docs に is_global フラグを追加
-- グローバルナレッジ（全テナント共通）を識別するための列

ALTER TABLE faq_docs ADD COLUMN IF NOT EXISTS is_global BOOLEAN DEFAULT false;

-- インデックス: グローバルナレッジフィルタリング高速化
CREATE INDEX IF NOT EXISTS idx_faq_docs_is_global ON faq_docs (is_global) WHERE is_global = true;
