-- Phase72-A: テナント設定変更 監査ログ（人間がVPSで実行）
CREATE TABLE IF NOT EXISTS tenant_settings_history (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  changed_by  TEXT        NOT NULL DEFAULT '',
  field_name  TEXT        NOT NULL,
  old_value   JSONB       NOT NULL DEFAULT 'null'::jsonb,
  new_value   JSONB       NOT NULL DEFAULT 'null'::jsonb,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tsh_tenant_at ON tenant_settings_history(tenant_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tsh_field ON tenant_settings_history(field_name);
