-- Phase39: 課金管理カラム追加
-- billing_enabled = false → 未課金（usage_logsには記録するがStripeに送らない）
-- billing_enabled = true  → 課金中
-- billing_free_until      → この日時まで無料（billing_enabled=trueでもStripe送信スキップ）
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_enabled BOOLEAN DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_free_until TIMESTAMPTZ DEFAULT NULL;
