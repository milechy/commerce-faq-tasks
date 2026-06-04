-- Phase44: book_uploads テーブル作成
-- 書籍PDFアップロード管理テーブル（AES-256-GCM暗号化 + Supabase Storage）
-- tenant_id スコープ強制 — 全クエリに tenant_id フィルタあり

-- ============================================================
-- 1. book_uploads テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS book_uploads (
  id                 SERIAL         PRIMARY KEY,

  -- テナント分離 — tenantId は JWT/APIキーから取得、bodyから禁止（CLAUDE.md）
  tenant_id          TEXT           NOT NULL,

  -- 書籍メタデータ
  title              TEXT           NOT NULL,
  original_filename  TEXT           NOT NULL,

  -- Supabase Storage パス: {tenant_id}/{uuid}.pdf[.enc]
  -- storage_path はレスポンスに含めない（セキュリティ）
  storage_path       TEXT           NOT NULL,

  file_size_bytes    INTEGER,

  -- AES-256-GCM 暗号化 IV（16バイト hex文字列）
  -- KNOWLEDGE_ENCRYPTION_KEY が設定されている場合のみ使用
  -- authTag (16バイト) は encrypted バッファ末尾に連結されている
  -- NULL = 平文保存フォールバック（KNOWLEDGE_ENCRYPTION_KEY 未設定時）
  encryption_iv      TEXT,

  uploaded_by        TEXT,          -- Supabase Auth ユーザー ID

  -- パイプライン状態: uploaded → processing → chunked → embedded / error
  status             TEXT           NOT NULL DEFAULT 'uploaded'
                       CONSTRAINT book_uploads_status_check
                       CHECK (status IN ('uploaded', 'processing', 'chunked', 'embedded', 'error')),

  -- パイプライン統計
  page_count         INTEGER        DEFAULT 0,
  chunk_count        INTEGER        DEFAULT 0,
  error_message      TEXT,

  -- Phase44 コンテンツ種別自動判定（analyzeContentType）
  -- 例: psychology_book / sales_manual / product_catalog / business_document / general_report / other
  content_type        TEXT,
  content_type_label  TEXT,         -- 日本語ラベル（例: 心理学書籍）
  -- JSONB: SchemaField[] — 動的スキーマフィールド定義
  suggested_schema    JSONB,
  -- 0.0–1.0: コンテンツ種別判定の確信度
  schema_confidence   REAL,
  schema_reasoning    TEXT,

  created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE book_uploads IS 'Phase44: 書籍PDFアップロード管理。storage_path はレスポンス非公開。';
COMMENT ON COLUMN book_uploads.encryption_iv IS 'AES-256-GCM 暗号化 IV（hex）。KNOWLEDGE_ENCRYPTION_KEY 設定時のみ使用。authTag はバッファ末尾 16 バイトに連結。NULL = 平文フォールバック。';
COMMENT ON COLUMN book_uploads.storage_path IS 'Supabase Storage パス: {tenant_id}/{uuid}.pdf[.enc]。APIレスポンスに含めない。';
COMMENT ON COLUMN book_uploads.status IS 'パイプライン状態: uploaded → processing → chunked → embedded / error';
COMMENT ON COLUMN book_uploads.suggested_schema IS 'Phase44 analyzeContentType が返す SchemaField[] の JSONB。フィールドホワイトリスト: situation/resistance/principle/contraindication/example/failure_example 等。';

-- ============================================================
-- 2. book_uploads インデックス
-- ============================================================

-- テナント × ステータス（ステータスフィルタ一覧取得で使用）
CREATE INDEX IF NOT EXISTS idx_book_uploads_tenant_status
  ON book_uploads (tenant_id, status);

-- テナント × 作成日（GET /v1/admin/knowledge/book-pdf の ORDER BY created_at DESC）
CREATE INDEX IF NOT EXISTS idx_book_uploads_tenant_created
  ON book_uploads (tenant_id, created_at DESC);

-- ============================================================
-- 3. faq_embeddings — Book RAG 用インデックス
-- Phase44: metadata->>'source' = 'book' AND metadata->>'book_id' でフィルタするクエリが多発
-- GET /chunks, DELETE chunk, DELETE book（book_id でまとめて削除）に使用
-- ============================================================

-- source='book' かつ book_id でのフィルタ（text / GIN / jsonb_path_ops）
CREATE INDEX IF NOT EXISTS idx_faq_embeddings_book_source
  ON faq_embeddings ((metadata->>'source'), (metadata->>'book_id'))
  WHERE (metadata->>'source') = 'book';

-- テナント × source='book'（RAG クエリでテナント分離しながら書籍チャンクを取得）
CREATE INDEX IF NOT EXISTS idx_faq_embeddings_tenant_book
  ON faq_embeddings (tenant_id, (metadata->>'source'))
  WHERE (metadata->>'source') = 'book';
