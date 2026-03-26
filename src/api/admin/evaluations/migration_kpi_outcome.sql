-- Phase45: outcome カラム追加マイグレーション
-- Stream A: conversation_evaluations テーブルへの KPI 列追加

ALTER TABLE conversation_evaluations ADD COLUMN IF NOT EXISTS outcome TEXT DEFAULT 'unknown';
ALTER TABLE conversation_evaluations ADD COLUMN IF NOT EXISTS outcome_updated_by TEXT;
ALTER TABLE conversation_evaluations ADD COLUMN IF NOT EXISTS outcome_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conv_eval_outcome ON conversation_evaluations(outcome);

-- tuning_rules への status / approved_at / rejected_at 追加（approve/reject API 向け）
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tuning_rules_status ON tuning_rules(status);
