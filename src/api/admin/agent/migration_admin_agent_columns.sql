-- Phase B-Admin: AIエージェントが操作するカラム追加（人間承認・SSHトンネル経由で手動実行）
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS ga4_measurement_id TEXT,
  ADD COLUMN IF NOT EXISTS posthog_host        TEXT DEFAULT 'https://app.posthog.com',
  ADD COLUMN IF NOT EXISTS widget_theme        JSONB DEFAULT '{}'::jsonb;
COMMENT ON COLUMN tenants.ga4_measurement_id IS 'GA4 Measurement ID (G-XXXX形式)';
COMMENT ON COLUMN tenants.posthog_host IS 'PostHog ホスト URL';
COMMENT ON COLUMN tenants.widget_theme IS 'ウィジェットテーマ (JSONB merge)';
