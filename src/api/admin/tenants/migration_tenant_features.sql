-- Migration: テナントに features(JSONB) と lemonslice_agent_id カラムを追加
-- 実行: psql $DATABASE_URL -f migration_tenant_features.sql

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{"avatar": false, "voice": false, "rag": true}';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS lemonslice_agent_id TEXT DEFAULT NULL;
