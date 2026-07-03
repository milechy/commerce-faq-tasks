-- Phase74: Hermes Agent — hermes_strategy_proposals
-- 実行日: VPS で手動実行
-- 対象: VPS PostgreSQL (65.108.159.161)
--
-- 設計意図:
--   実物のHermes Agent(Nous Research製、別VPSで稼働)が、同意済みテナントの
--   会話ログ(search_conversations経由)を読解・分析して生成したCVR改善提案を、
--   POST /v1/hermes-mcp/proposals 経由で投稿・永続化するためのテーブル。
--
--   Hermesは提案を作るだけで、system_prompt / system_prompt_variants を
--   自動書き換えしない。実適用は管理者が既存のPUT /v1/admin/variants等を
--   手動で叩く前提(提案→人間承認ゲート)。
--
-- テナント越境防止方針 (重要):
--   scope='global' の行は、同意済みテナントの会話データのみを横断分析した
--   結果に基づく(search_conversationsが同意済みテナントしか返さないため、
--   Hermes側の入力データ自体が既に同意ゲート済み)。
--   scope='tenant' の行は必ず tenant_id を持ち、global 行は必ず tenant_id を
--   持たないことを chk_hermes_scope で DB 層から構造的に保証する。
--   投稿API側でも scope='tenant' の場合は同意状態を再検証する(defense in depth)。

-- ============================================================
-- 1. hermes_strategy_proposals テーブル本体
-- ============================================================

CREATE TABLE IF NOT EXISTS hermes_strategy_proposals (
  id               BIGSERIAL PRIMARY KEY,
  scope            TEXT NOT NULL,                    -- 'global' | 'tenant'
  tenant_id        TEXT,                             -- scope='tenant' のみ非NULL
  title            TEXT NOT NULL,
  rationale        TEXT NOT NULL,                    -- Hermesが会話内容を読解した根拠
  suggested_action TEXT NOT NULL,                    -- 提案する具体的アクション(Hermesは適用しない)
  evidence         JSONB DEFAULT '{}'::jsonb,         -- 参照したsession_id等の裏付け情報
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  dedup_key        TEXT NOT NULL,
  submitted_by     TEXT NOT NULL DEFAULT 'hermes-agent',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  decided_at       TIMESTAMPTZ,
  decided_by       TEXT
);

-- 越境ガード: global は tenant_id を持てない / tenant は tenant_id 必須
ALTER TABLE hermes_strategy_proposals
  DROP CONSTRAINT IF EXISTS chk_hermes_scope;
ALTER TABLE hermes_strategy_proposals
  ADD CONSTRAINT chk_hermes_scope
  CHECK (
    (scope = 'global' AND tenant_id IS NULL)
    OR (scope = 'tenant' AND tenant_id IS NOT NULL)
  );

-- ============================================================
-- 2. インデックス
-- ============================================================

-- 同一提案の再投稿を弾く (pending の間のみ一意)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hermes_proposal_dedup
  ON hermes_strategy_proposals (dedup_key)
  WHERE status = 'pending';

-- Admin API 一覧表示用 (scope + status で絞り込み、新しい順)
CREATE INDEX IF NOT EXISTS idx_hermes_proposal_scope_status
  ON hermes_strategy_proposals (scope, status, created_at DESC);

-- tenant 別一覧用
CREATE INDEX IF NOT EXISTS idx_hermes_proposal_tenant
  ON hermes_strategy_proposals (tenant_id)
  WHERE tenant_id IS NOT NULL;

COMMENT ON TABLE hermes_strategy_proposals IS 'Phase74: 実物のHermes Agentが会話ログ分析から生成するCVR向上戦略提案。提案→人間承認ゲート方式で自動適用はしない。';
COMMENT ON COLUMN hermes_strategy_proposals.scope IS 'global=同意済みテナント横断の分析パターン / tenant=特定テナントの会話に基づく提案';
COMMENT ON COLUMN hermes_strategy_proposals.evidence IS '参照したsession_id等の裏付け情報。生の会話全文は含めないこと。';

-- ============================================================
-- 確認クエリ (実行後に手動確認)
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'hermes_strategy_proposals' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'hermes_strategy_proposals';
-- SELECT conname FROM pg_constraint WHERE conrelid = 'hermes_strategy_proposals'::regclass;
