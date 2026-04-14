-- Phase61: option_orders テーブル
-- オプションサービス発注の管理テーブル
-- chat_session_id は REFERENCES なし（セッション削除後も発注記録を保持）

CREATE TABLE IF NOT EXISTS option_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  chat_session_id UUID,
  description TEXT NOT NULL,
  llm_estimate_amount INTEGER,
  final_amount INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  stripe_usage_recorded BOOLEAN NOT NULL DEFAULT FALSE,
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_option_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_option_status CHECK (status IN ('pending', 'in_progress', 'completed'))
);

CREATE INDEX IF NOT EXISTS idx_option_orders_tenant ON option_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_option_orders_status ON option_orders(status);
CREATE INDEX IF NOT EXISTS idx_option_orders_created ON option_orders(created_at DESC);
