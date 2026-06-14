-- Phase72-C: conversation_flow_logs（State Machine 遷移ログ）
-- 実行日: VPS で手動実行
-- 対象: VPS PostgreSQL (65.108.159.161)
--
-- 設計意図:
--   Phase22 State Machine（clarify → answer → confirm → terminal）の
--   各遷移を永続ログとして記録し、フロー分析 API とファネル可視化 UI を提供する。
--   テナント分離された fire-and-forget INSERT（API レスポンス速度に影響しない）。
--
--   フック先: src/agent/orchestrator/flowControl.ts の
--   applyPhase22FlowAfterGeneration 内の遷移検出ブロック
--   （prevFlow.state !== nextState が真の条件分岐）。
--
-- テナント分離方針:
--   tenant_id を必須 NOT NULL とする。全クエリで tenant_id フィルタを使用。
--   super_admin は全テナントを横断できる（API 層で制御）。

-- ============================================================
-- 1. conversation_flow_logs テーブル本体
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_flow_logs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  from_state  TEXT,                              -- NULL = セッション開始（初回遷移）
  to_state    TEXT NOT NULL,                     -- FlowState（clarify/answer/confirm/terminal）または terminalReason 情報
  turn_index  INT NOT NULL DEFAULT 0,
  metadata    JSONB DEFAULT '{}'::jsonb,          -- loop_abort 等の追加情報
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. インデックス
-- ============================================================

-- セッション単位検索（セッション全遷移ログ取得）
CREATE INDEX IF NOT EXISTS idx_flow_logs_tenant_session
  ON conversation_flow_logs (tenant_id, session_id);

-- 期間別テナント集計（分析 API の主クエリ）
CREATE INDEX IF NOT EXISTS idx_flow_logs_tenant_logged_at
  ON conversation_flow_logs (tenant_id, logged_at DESC);

-- to_state 別フィルタ（ファネル集計）
CREATE INDEX IF NOT EXISTS idx_flow_logs_to_state
  ON conversation_flow_logs (to_state);

-- 全テナント期間集計（super_admin 向け）
CREATE INDEX IF NOT EXISTS idx_flow_logs_logged_at
  ON conversation_flow_logs (logged_at DESC);

COMMENT ON TABLE conversation_flow_logs IS 'Phase72-C: Phase22 State Machine の遷移ログ。clarify/answer/confirm/terminal の各遷移を非同期 fire-and-forget で記録。';
COMMENT ON COLUMN conversation_flow_logs.from_state IS 'Phase72-C: 遷移前の FlowState（NULL = セッション初回遷移）。';
COMMENT ON COLUMN conversation_flow_logs.to_state IS 'Phase72-C: 遷移後の FlowState（clarify/answer/confirm/terminal）。';
COMMENT ON COLUMN conversation_flow_logs.metadata IS 'Phase72-C: terminalReason 等の補足情報を格納する JSONB。';

-- ============================================================
-- 確認クエリ (実行後に手動確認)
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'conversation_flow_logs' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'conversation_flow_logs';
