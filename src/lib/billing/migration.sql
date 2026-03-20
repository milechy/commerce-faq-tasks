-- Phase32: 使用量ログ・課金テーブル
-- Stream A

-- テナントとStripeのマッピング
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APIリクエスト使用量ログ
CREATE TABLE IF NOT EXISTS usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  feature_used TEXT NOT NULL CHECK (feature_used IN ('chat', 'avatar', 'voice')),
  cost_llm_cents INTEGER NOT NULL DEFAULT 0,
  cost_total_cents INTEGER NOT NULL DEFAULT 0,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  billing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (billing_status IN ('pending', 'reported', 'paid', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stripe UsageRecord送信の冪等管理
CREATE TABLE IF NOT EXISTS stripe_usage_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  period_yyyymm TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  stripe_usage_record_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase40: TTS / Avatar追加コストカラム（既存DBへの追加マイグレーション）
ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS tts_text_bytes  INTEGER,
  ADD COLUMN IF NOT EXISTS avatar_credits  INTEGER,
  ADD COLUMN IF NOT EXISTS avatar_session_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant_id ON usage_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_billing_status ON usage_logs(billing_status);
CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant_created ON usage_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stripe_usage_reports_tenant_period
  ON stripe_usage_reports(tenant_id, period_yyyymm);
