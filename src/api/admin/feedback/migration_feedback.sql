-- src/api/admin/feedback/migration_feedback.sql
-- テナント↔Super Admin フィードバックチャット

CREATE TABLE IF NOT EXISTS feedback_messages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('client_admin', 'super_admin')),
  sender_email TEXT,
  content TEXT NOT NULL,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_tenant ON feedback_messages(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_unread ON feedback_messages(tenant_id, is_read) WHERE is_read = false;
