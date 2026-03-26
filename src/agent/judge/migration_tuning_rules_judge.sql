-- Phase45: tuning_rules テーブルへの Judge 関連カラム追加

ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMPTZ;
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS evidence JSONB;
