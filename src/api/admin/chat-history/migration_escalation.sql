-- GID 1216275508391900: 有人チャットへのシームレスエスカレーション
-- is_escalated: このセッションが有人対応を要求済みか。escalated_at: 要求日時。
-- escalation_resolved_at: 対応完了日時（NULL = 対応中一覧に表示される「進行中」状態）。
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_escalated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS escalation_resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_active_escalations
  ON chat_sessions(tenant_id, escalated_at DESC)
  WHERE is_escalated = true AND escalation_resolved_at IS NULL;

-- chat_messages.role の CHECK 制約に 'operator'（有人オペレーターの返信）を追加。
-- 制約名は環境によって異なる可能性があるため、pg_constraint から動的に特定して置き換える。
-- 再実行しても安全なよう、既存の role 用CHECK制約（名前を問わず）を都度落としてから付け直す。
DO $$
DECLARE
  cname TEXT;
BEGIN
  FOR cname IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'chat_messages'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE chat_messages DROP CONSTRAINT %I', cname);
  END LOOP;

  ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_role_check
    CHECK (role IN ('user', 'assistant', 'operator'));
END $$;
