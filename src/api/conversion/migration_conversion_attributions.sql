-- src/api/conversion/migration_conversion_attributions.sql
-- Phase58: コンバージョン帰属分析テーブル

CREATE TABLE IF NOT EXISTS conversion_attributions (
  id SERIAL PRIMARY KEY,
  session_id UUID,
  tenant_id TEXT NOT NULL,
  psychology_principle_used TEXT[] DEFAULT '{}',
  trigger_type TEXT,
  trigger_rule_id INTEGER,
  temp_score_at_conversion INTEGER,
  conversion_type TEXT NOT NULL CHECK (conversion_type IN (
    'purchase', 'inquiry', 'reservation', 'signup', 'other'
  )),
  conversion_value NUMERIC,
  sales_stage_at_conversion TEXT,
  message_count INTEGER,
  session_duration_sec INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ca_tenant ON conversion_attributions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ca_tenant_created ON conversion_attributions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_session ON conversion_attributions(session_id);
