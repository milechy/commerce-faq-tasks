-- Phase46: 反論パターン自動学習

CREATE TABLE IF NOT EXISTS objection_patterns (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  trigger_phrase TEXT NOT NULL,
  response_strategy TEXT NOT NULL,
  principle_used TEXT,
  success_rate REAL DEFAULT 0,
  sample_count INTEGER DEFAULT 0,
  source TEXT DEFAULT 'auto',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_objection_tenant ON objection_patterns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_objection_trigger ON objection_patterns USING GIN (to_tsvector('japanese', trigger_phrase));
