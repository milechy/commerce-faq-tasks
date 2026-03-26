-- Phase44: book_uploads テーブル新設
CREATE TABLE IF NOT EXISTS book_uploads (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  page_count INTEGER,
  chunk_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded',
  error_message TEXT,
  encryption_iv TEXT,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- status遷移: uploaded → processing → chunked → embedded → error
-- chunk_count: P0-2チャンク構造化パイプライン完了後に更新される

CREATE INDEX IF NOT EXISTS idx_book_uploads_tenant_id ON book_uploads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_book_uploads_status ON book_uploads(status);
CREATE INDEX IF NOT EXISTS idx_book_uploads_tenant_status ON book_uploads(tenant_id, status);

-- Phase44: faq_embeddings.metadata への検索インデックス
-- metadata->>'source' = 'book' / 'principle' での絞り込みを高速化
CREATE INDEX IF NOT EXISTS idx_faq_embeddings_source
  ON faq_embeddings ((metadata->>'source'));

CREATE INDEX IF NOT EXISTS idx_faq_embeddings_principle
  ON faq_embeddings ((metadata->>'principle'));

CREATE INDEX IF NOT EXISTS idx_faq_embeddings_book_id
  ON faq_embeddings ((metadata->>'book_id'))
  WHERE metadata->>'book_id' IS NOT NULL;
