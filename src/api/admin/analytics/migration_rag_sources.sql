-- Phase68: ナレッジ別CV影響度解析用カラム
-- chat_messages に RAG で使用されたチャンクの記録を追加する。
--
-- rag_sources の構造（assistant メッセージのみ記録）:
--   [
--     { "chunk_id": "<faq_embeddings.id>", "source": "faq"|"book",
--       "score": <number>, "principle": "<string>" }   // book 時のみ principle
--   ]
--
-- user メッセージでは NULL のまま。

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS rag_sources JSONB DEFAULT NULL;

-- jsonb_array_elements での集計を高速化する GIN インデックス
CREATE INDEX IF NOT EXISTS idx_chat_messages_rag_sources
  ON chat_messages USING GIN (rag_sources);

-- ============================================================
-- 確認クエリ (実行後に手動実行して確認)
-- ============================================================
-- \d chat_messages
-- SELECT COUNT(*) FROM chat_messages WHERE rag_sources IS NOT NULL;
