-- Phase72-D: metrics_snapshots テーブル
-- 実行は DBA/人間 が行う（コードは適用済みを前提として実装）
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id          BIGSERIAL    PRIMARY KEY,
  metric_name TEXT         NOT NULL,
  tenant_id   TEXT,
  labels      JSONB        NOT NULL DEFAULT '{}',
  value       NUMERIC      NOT NULL,
  snapshot_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_name_tenant_at
  ON metrics_snapshots (metric_name, tenant_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_at
  ON metrics_snapshots (snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_name_at
  ON metrics_snapshots (metric_name, snapshot_at DESC);
