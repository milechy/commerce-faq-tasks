-- Phase52h: In-App通知センター — notifications テーブル

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  recipient_role VARCHAR(50) NOT NULL,
  recipient_tenant_id VARCHAR(100),
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  link VARCHAR(500),
  is_read BOOLEAN DEFAULT false,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_role, recipient_tenant_id, is_read);

CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications(created_at DESC);
