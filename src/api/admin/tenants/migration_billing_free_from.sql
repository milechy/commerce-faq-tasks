-- Phase39b: 無料期間に開始日カラム追加
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_free_from TIMESTAMPTZ DEFAULT NULL;
