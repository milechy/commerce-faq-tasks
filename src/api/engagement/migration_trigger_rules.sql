-- src/api/engagement/migration_trigger_rules.sql
-- Phase56: プロアクティブエンゲージメント — trigger_rules テーブル

CREATE TABLE IF NOT EXISTS trigger_rules (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'scroll_depth', 'idle_time', 'exit_intent', 'page_url_match'
  )),
  trigger_config JSONB NOT NULL,
  message_template TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trigger_rules_tenant ON trigger_rules(tenant_id);
