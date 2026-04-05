-- src/api/conversion/migration_ab_experiments.sql
-- Phase58: A/Bテストフレームワーク テーブル

CREATE TABLE IF NOT EXISTS ab_experiments (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  variant_a JSONB NOT NULL,
  variant_b JSONB NOT NULL,
  traffic_split NUMERIC NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'completed', 'cancelled')),
  min_sample_size INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ab_results (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER REFERENCES ab_experiments(id),
  variant TEXT NOT NULL CHECK (variant IN ('a', 'b')),
  session_id UUID,
  converted BOOLEAN NOT NULL,
  judge_score INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ab_exp_tenant ON ab_experiments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ab_results_exp ON ab_results(experiment_id);
