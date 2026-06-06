-- Phase71-A: learned_memory（学習ループの semantic memory tier）
-- 実行日: VPS で手動実行
-- 対象: VPS PostgreSQL (65.108.159.161) — pgvector 拡張が有効であること
--
-- 設計意図:
--   Judge が高スコア (>= LEARNED_MEMORY_THRESHOLD) と評価した会話を
--   正規 Q&A ペアに蒸留し、テナント分離された semantic memory として蓄積する。
--   検索時に faq_embeddings (キュレーション済みFAQ) と並列取得してマージし、
--   「過去に上手くいった応答」を次回以降の RAG に還元する = メモリベースの学習。
--
--   GoClaw の 3層メモリ (working/episodic/semantic) のうち semantic tier に相当。
--   faq_embeddings に相乗りせず別テーブルにする理由:
--     - 既存検索は faq_docs JOIN で孤児を弾く設計 → 学習データが弾かれてしまう
--     - キュレーション済み FAQ を汚さない / 学習データだけ重み・ガバナンスを分離
--     - 将来 decay / 失効ポリシーを learned 専用に持たせやすい
--
-- テナント分離方針 (重要):
--   verbatim な Q&A 内容はテナント横断で共有しない (tenant_id = $1 のみ)。
--   横断学習は既存 crossTenantContext の「集計統計のみ共有」方式を踏襲する。

-- ============================================================
-- 1. learned_memory テーブル本体
-- ============================================================

CREATE TABLE IF NOT EXISTS learned_memory (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  question          TEXT NOT NULL,            -- 蒸留した正規質問 (AES-256-GCM 暗号化)
  answer            TEXT NOT NULL,            -- 蒸留した正規応答 (AES-256-GCM 暗号化)
  embedding         VECTOR(1536) NOT NULL,    -- question の埋め込み (text-embedding-3-small)
  source_session_id TEXT NOT NULL,            -- 蒸留元の chat_sessions.session_id
  judge_score       INTEGER NOT NULL,         -- 蒸留時の overall_score (0-100)
  metadata          JSONB DEFAULT '{}'::jsonb,
  is_active         BOOLEAN DEFAULT TRUE,     -- 失効/手動無効化フラグ
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. インデックス
-- ============================================================

-- テナント分離フィルター用
CREATE INDEX IF NOT EXISTS idx_learned_memory_tenant
  ON learned_memory (tenant_id);

-- ANN 検索用 (cosine)。faq_embeddings と同じ ivfflat 方式。
CREATE INDEX IF NOT EXISTS idx_learned_memory_embedding
  ON learned_memory
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 有効エントリのみ検索する部分インデックス
CREATE INDEX IF NOT EXISTS idx_learned_memory_active
  ON learned_memory (tenant_id, is_active)
  WHERE is_active = true;

-- 1セッションにつき1学習エントリ (蒸留の重複防止 / ON CONFLICT DO NOTHING のキー)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_learned_memory_session
  ON learned_memory (tenant_id, source_session_id);

COMMENT ON TABLE learned_memory IS 'Phase71-A: Judge高スコア会話を蒸留した semantic memory。RAG検索時に faq_embeddings と並列取得・マージされる。';
COMMENT ON COLUMN learned_memory.judge_score IS 'Phase71-A: 蒸留時の Judge overall_score (0-100)。検索時の重み付けに利用可能。';

-- ============================================================
-- 確認クエリ (実行後に手動確認)
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'learned_memory' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'learned_memory';
