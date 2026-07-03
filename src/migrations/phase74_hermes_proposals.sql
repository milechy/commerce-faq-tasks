-- Phase74: Hermes Agent — hermes_strategy_proposals
-- 実行日: VPS で手動実行
-- 対象: VPS PostgreSQL (65.108.159.161)
--
-- 設計意図:
--   Hermes Agent (中央学習エージェント) が既存の crossTenantContext (匿名横断集計) と
--   autoTuning の detect 群 (tenant 別 A/B 勝者・Judge 反復提案・心理原則ランキング) を
--   束ねて生成する「CVR向上のための戦略提案」を永続化する。
--
--   Hermes は提案を作るだけで、system_prompt / system_prompt_variants を自動書き換えしない。
--   実適用は管理者が既存の PUT /v1/admin/variants を手動で叩く (提案→人間承認ゲート)。
--
-- テナント越境防止方針 (重要):
--   scope='global' の行は crossTenantContext 由来の匿名集計にのみ基づく。
--   生の会話ログ・PII は rationale/evidence に一切含めない (集計値・principle名・experiment_id のみ)。
--   scope='tenant' の行は必ず tenant_id を持ち、global 行は必ず tenant_id を持たない
--   ことを chk_hermes_scope で DB 層から構造的に保証する。

-- ============================================================
-- 1. hermes_strategy_proposals テーブル本体
-- ============================================================

CREATE TABLE IF NOT EXISTS hermes_strategy_proposals (
  id               BIGSERIAL PRIMARY KEY,
  scope            TEXT NOT NULL,                    -- 'global' | 'tenant'
  tenant_id        TEXT,                             -- scope='tenant' のみ非NULL
  proposal_type    TEXT NOT NULL,                    -- 'xt_principle' | 'ab_winner' | 'judge_repeated' | 'effectiveness_top'
  title            TEXT NOT NULL,
  rationale        TEXT NOT NULL,                    -- 匿名集計/tenant別集計に基づく根拠 (生ログ不可)
  suggested_action TEXT NOT NULL,                    -- 例: "variant B を昇格" (Hermesは適用しない)
  evidence         JSONB DEFAULT '{}'::jsonb,         -- 集計値のみ (CV率/サンプル数/principle名/experiment_id)
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | applied
  dedup_key        TEXT NOT NULL,
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

-- 同一提案の再生成を弾く (pending の間のみ一意)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hermes_dedup
  ON hermes_strategy_proposals (dedup_key)
  WHERE status = 'pending';

-- Admin API 一覧表示用 (scope + status で絞り込み、新しい順)
CREATE INDEX IF NOT EXISTS idx_hermes_scope_status
  ON hermes_strategy_proposals (scope, status, created_at DESC);

-- tenant 別一覧用
CREATE INDEX IF NOT EXISTS idx_hermes_tenant
  ON hermes_strategy_proposals (tenant_id)
  WHERE tenant_id IS NOT NULL;

COMMENT ON TABLE hermes_strategy_proposals IS 'Phase74: Hermes Agent が生成するCVR向上戦略提案。提案→人間承認ゲート方式で自動適用はしない。';
COMMENT ON COLUMN hermes_strategy_proposals.scope IS 'global=crossTenantContext由来の匿名横断提案 / tenant=既存autoTuning detect群由来のテナント別提案';
COMMENT ON COLUMN hermes_strategy_proposals.evidence IS '集計値のみ格納。会話文・顧客情報・PIIを含めないこと。';

-- ============================================================
-- 確認クエリ (実行後に手動確認)
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'hermes_strategy_proposals' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'hermes_strategy_proposals';
-- SELECT conname FROM pg_constraint WHERE conrelid = 'hermes_strategy_proposals'::regclass;
