-- Phase45 Stream A: new per-axis score columns + feedback + suggested_rules
ALTER TABLE conversation_evaluations
  ADD COLUMN IF NOT EXISTS psychology_fit_score INTEGER CHECK (psychology_fit_score >= 0 AND psychology_fit_score <= 100),
  ADD COLUMN IF NOT EXISTS customer_reaction_score INTEGER CHECK (customer_reaction_score >= 0 AND customer_reaction_score <= 100),
  ADD COLUMN IF NOT EXISTS stage_progress_score INTEGER CHECK (stage_progress_score >= 0 AND stage_progress_score <= 100),
  ADD COLUMN IF NOT EXISTS taboo_violation_score INTEGER CHECK (taboo_violation_score >= 0 AND taboo_violation_score <= 100),
  ADD COLUMN IF NOT EXISTS feedback JSONB,
  ADD COLUMN IF NOT EXISTS suggested_rules JSONB,
  ADD COLUMN IF NOT EXISTS message_count INTEGER,
  ADD COLUMN IF NOT EXISTS sales_stage TEXT,
  ADD COLUMN IF NOT EXISTS judge_model TEXT DEFAULT 'llama-3.3-70b-versatile';

CREATE INDEX IF NOT EXISTS idx_evaluations_tenant ON conversation_evaluations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_score ON conversation_evaluations(score);
CREATE INDEX IF NOT EXISTS idx_evaluations_date ON conversation_evaluations(evaluated_at DESC);
