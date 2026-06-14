-- Phase72-D: metrics_snapshots（Prometheus メトリクス時系列スナップショット）
-- 実行日: VPS で手動実行
-- 対象: VPS PostgreSQL (65.108.159.161)
--
-- 設計意図:
--   Prometheus の Counter/Histogram メトリクスを 5 分周期で PostgreSQL に保存し、
--   管理 UI で時系列グラフ表示できる永続ストレージを提供する。
--   Counter は前回値との差分（delta）をスナップショット。
--   Histogram は sum/count から平均を計算して record する。
--
--   フック先: src/lib/metrics/metricsFlush.ts（initMetricsFlush）
--   エンドポイント: GET /v1/admin/analytics/metrics-history（super_admin 限定）

-- ============================================================
-- 1. metrics_snapshots テーブル本体
-- ============================================================

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  metric_name TEXT NOT NULL,
  tenant_id   TEXT,                              -- NULL = 全テナント集計
  labels      JSONB NOT NULL DEFAULT '{}',        -- Prometheus ラベルセット
  value       NUMERIC NOT NULL,                  -- Counter: delta / Histogram: avg_ms
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. インデックス
-- ============================================================

-- メトリクス名 + テナント + 時系列（主要クエリ: DATE_TRUNC バケット集計）
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_name_tenant_at
  ON metrics_snapshots (metric_name, tenant_id, snapshot_at DESC);

-- 時系列全体（全メトリクス横断参照）
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_at
  ON metrics_snapshots (snapshot_at DESC);

-- メトリクス名 + 時系列（テナントフィルタなし集計）
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_name_at
  ON metrics_snapshots (metric_name, snapshot_at DESC);

COMMENT ON TABLE metrics_snapshots IS 'Phase72-D: Prometheus KPI メトリクスの時系列スナップショット。5 分周期で INSERT。Counter は delta 値、Histogram は avg 値を格納。';
COMMENT ON COLUMN metrics_snapshots.metric_name IS 'Phase72-D: rajiuce_ prefix 付きメトリクス名（KPI_METRIC_NAMES 定数と対応）。';
COMMENT ON COLUMN metrics_snapshots.labels IS 'Phase72-D: Prometheus ラベルセットを JSONB で保存。PII・書籍内容を含めないこと。';
COMMENT ON COLUMN metrics_snapshots.value IS 'Phase72-D: Counter は前回値との差分（負値はスキップ）、Histogram は sum/count の平均（count=0 の場合はスキップ）。';

-- ============================================================
-- 確認クエリ (実行後に手動確認)
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'metrics_snapshots' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'metrics_snapshots';
