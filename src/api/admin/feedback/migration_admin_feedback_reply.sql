-- Phase: admin_feedback に担当者⇔テナントの返信スレッド機能を追加
-- テナント側は1相談=1カード表示（多段チャットUIは持たない）。
-- 続きの相談は parent_feedback_id で親子リンクした新規行として作成する。

ALTER TABLE admin_feedback
  ADD COLUMN IF NOT EXISTS reply_body TEXT,
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replied_by_email TEXT,
  ADD COLUMN IF NOT EXISTS reply_read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parent_feedback_id UUID REFERENCES admin_feedback(id) ON DELETE SET NULL;

-- テナント側の「未読返信バッジ」集計用
CREATE INDEX IF NOT EXISTS idx_admin_feedback_unread_reply
  ON admin_feedback(tenant_id)
  WHERE reply_body IS NOT NULL AND reply_read_at IS NULL;
