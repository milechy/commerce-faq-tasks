-- Sai代行タスクの所有権レジストリ
--
-- 目的: task_id から「依頼したテナント」を解決する単一情報源。
-- これが無かったため get_sai_task_status は所有権を照合できず、
-- 任意の task_id を Sai VPS へそのまま転送していた（越境読み取り + 課金の誤帰属）。
--
-- なぜ option_orders に相乗りしないか:
--   チャット起点(request_sai_task)の依頼は「発注(option_orders)」ではない。
--   発注行を作ると super_admin の代行作業キュー・請求フローに実在しない発注が混ざる。
--   逆に option_orders.sai_task_id は「最後に試行したタスク」を保持する列であり
--   （試行のたびに上書き・履歴を持たない）、所有権の照合先には使えない。
--   したがって両経路が共通して書き込む専用レジストリを置く。
--
-- 参照制約は option_orders と同じ規約に合わせる（tenants(id) への FK）。

CREATE TABLE IF NOT EXISTS sai_tasks (
  task_id TEXT PRIMARY KEY,                    -- Sai VPS が採番したタスクID
  tenant_id TEXT NOT NULL,                     -- 依頼元テナント。所有権照合の唯一の根拠
  order_id UUID,                               -- option_orders 経由の場合のみ。チャット起点は NULL
  description TEXT NOT NULL,                   -- 依頼内容（監査証跡。従来どこにも残っていなかった）
  requested_by TEXT,                           -- 依頼した管理ユーザーのメール。不明時は NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_sai_tasks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_sai_tasks_tenant ON sai_tasks(tenant_id, created_at DESC);

COMMENT ON TABLE sai_tasks IS 'Sai代行タスクの所有権レジストリ。get_sai_task_status の越境防止に使う';
COMMENT ON COLUMN sai_tasks.tenant_id IS '依頼元テナント。この列との一致が唯一の閲覧許可条件';
COMMENT ON COLUMN sai_tasks.order_id IS 'option_orders 経由の依頼のみ設定。チャット起点(request_sai_task)は NULL';
COMMENT ON COLUMN sai_tasks.description IS '依頼内容の監査証跡。チャット起点の依頼は従来どこにも記録が残らなかった';
