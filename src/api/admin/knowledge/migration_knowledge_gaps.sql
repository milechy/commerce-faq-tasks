-- Phase38+: ナレッジギャップ検出テーブル
-- LLMが回答できなかった質問を自動記録し、ナレッジ追加を推薦する

CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_question TEXT NOT NULL,
  session_id UUID,
  message_id BIGINT,
  rag_hit_count INTEGER DEFAULT 0,
  rag_top_score REAL DEFAULT 0,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_faq_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_tenant
  ON knowledge_gaps(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_session
  ON knowledge_gaps(session_id)
  WHERE session_id IS NOT NULL;
