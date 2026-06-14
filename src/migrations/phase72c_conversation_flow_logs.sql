-- Phase72-C: State Machine 遷移ログテーブル
-- 実行: psql $DATABASE_URL -f src/migrations/phase72c_conversation_flow_logs.sql
-- 注意: このファイルは人間が手動で実行する（自動適用禁止）

CREATE TABLE IF NOT EXISTS conversation_flow_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  turn_index INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cfl_tenant_session ON conversation_flow_logs(tenant_id, session_id);
CREATE INDEX IF NOT EXISTS idx_cfl_tenant_logged ON conversation_flow_logs(tenant_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_cfl_to_state ON conversation_flow_logs(to_state);
