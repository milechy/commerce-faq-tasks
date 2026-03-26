-- Phase45: conversation_evaluations テーブル
-- Judge評価エンジンの評価結果を保存する

CREATE TABLE IF NOT EXISTS conversation_evaluations (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  used_principles JSONB DEFAULT '[]',
  effective_principles JSONB DEFAULT '[]',
  failed_principles JSONB DEFAULT '[]',
  evaluation_axes JSONB NOT NULL,
  notes TEXT,
  model_used TEXT DEFAULT 'llama-3.3-70b-versatile',
  evaluated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_eval_tenant_id ON conversation_evaluations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conv_eval_session_id ON conversation_evaluations(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_eval_score ON conversation_evaluations(score);
CREATE INDEX IF NOT EXISTS idx_conv_eval_tenant_evaluated ON conversation_evaluations(tenant_id, evaluated_at DESC);
