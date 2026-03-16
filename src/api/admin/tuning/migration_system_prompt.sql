-- Phase38 Step6: テナント別システムプロンプト
-- tenantsテーブルに system_prompt カラムを追加

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS system_prompt TEXT DEFAULT '';
