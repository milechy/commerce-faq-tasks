-- Phase46: 週次レポートテーブル

CREATE TABLE IF NOT EXISTS weekly_reports (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT,
  content JSONB,
  read_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_tenant ON weekly_reports(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_unread ON weekly_reports(tenant_id, read_at) WHERE read_at IS NULL;
