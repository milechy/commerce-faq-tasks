-- Phase38 Step4-BE: チューニングルールテーブル

CREATE TABLE IF NOT EXISTS tuning_rules (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,           -- "global" = 全テナント共通
  trigger_pattern TEXT NOT NULL,     -- ユーザーの質問パターン
  expected_behavior TEXT NOT NULL,   -- LLMに期待する応答方針
  priority INTEGER DEFAULT 0,        -- 高い数値 = 高優先
  is_active BOOLEAN DEFAULT true,
  created_by TEXT,                   -- 作成者
  source_message_id BIGINT,          -- 元になったchat_messagesのID（任意）
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tuning_rules_tenant
  ON tuning_rules(tenant_id, is_active);
