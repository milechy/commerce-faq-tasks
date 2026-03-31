-- Phase52c: AI提案ルール編集履歴追跡カラム追加

ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS original_text TEXT;
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS edited_by VARCHAR(255);
ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
