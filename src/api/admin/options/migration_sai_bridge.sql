-- Phase2 (Sai接続ブリッジ): option_orders拡張マイグレーション
-- sai_task_id: Sai VPS側のタスクID（試行のたびに上書き、履歴は持たない）
-- sai_outcome: Sai側の自己申告結果（人間レビュー前の参考情報。確定判断には使わない）
-- sai_tried_at: 最後にSaiで試行した日時

ALTER TABLE option_orders
  ADD COLUMN IF NOT EXISTS sai_task_id TEXT,
  ADD COLUMN IF NOT EXISTS sai_outcome VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sai_tried_at TIMESTAMPTZ;
