-- docs/sql/0002_faq_embeddings_pgvector.sql

-- 1) pgvector 拡張がまだ有効でなければ有効化
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) RAG 用の埋め込みテーブル（Multi-tenant）
CREATE TABLE IF NOT EXISTS faq_embeddings (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  text        TEXT        NOT NULL,
  embedding   VECTOR(1536) NOT NULL,
  metadata    JSONB
);

-- 3) tenant_id での絞り込み用インデックス
CREATE INDEX IF NOT EXISTS faq_embeddings_tenant_id_idx
  ON faq_embeddings (tenant_id);

-- 4) ベクトル検索用インデックス (IVFFLAT + cosine)
-- ※ pgvector がインストールされている前提
--   lists の値はデータ量に応じて調整推奨
CREATE INDEX IF NOT EXISTS faq_embeddings_embedding_idx
  ON faq_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);