-- src/api/admin/feedback/migration_feedback_flagged.sql
-- 改善マーク機能: flagged_for_improvement カラム追加

ALTER TABLE feedback_messages
  ADD COLUMN IF NOT EXISTS flagged_for_improvement BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_feedback_flagged
  ON feedback_messages(flagged_for_improvement, created_at ASC)
  WHERE flagged_for_improvement = true;
