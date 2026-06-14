-- Phase72-A: tenant_settings_history（テナント設定変更 監査ログ）
-- 実行日: VPS で手動実行
-- 対象: VPS PostgreSQL (65.108.159.161)
--
-- 設計意図:
--   スーパー管理者によるテナント設定変更（plan, features, billing_enabled, is_active）を
--   フィールド単位で記録し、いつ・誰が・何を変えたかを追跡できるようにする。
--   変更前後の値を JSONB で保持し、任意のフィールドを履歴管理できる汎用設計。
--
-- テナント分離方針:
--   tenant_id で行を分離し、REFERENCES tenants(id) ON DELETE CASCADE で
--   テナント削除時に履歴も自動削除する。

-- ============================================================
-- 1. tenant_settings_history テーブル本体
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_settings_history (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  changed_by   TEXT NOT NULL,
  field_name   TEXT NOT NULL,
  old_value    JSONB,
  new_value    JSONB NOT NULL,
  changed_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. インデックス
-- ============================================================

-- テナント別の時系列クエリ用（最新順）
CREATE INDEX IF NOT EXISTS idx_tenant_settings_history_tenant_time
  ON tenant_settings_history (tenant_id, changed_at DESC);

-- フィールド名フィルタ用
CREATE INDEX IF NOT EXISTS idx_tenant_settings_history_field
  ON tenant_settings_history (field_name);

COMMENT ON TABLE tenant_settings_history IS 'Phase72-A: スーパー管理者によるテナント設定変更の監査ログ。plan/features/billing_enabled/is_active 等の変更を記録する。';
COMMENT ON COLUMN tenant_settings_history.changed_by IS 'Phase72-A: 変更を実行したスーパー管理者のメールアドレス。';
COMMENT ON COLUMN tenant_settings_history.old_value IS 'Phase72-A: 変更前の値（NULL = 新規設定 / 初期値不明）。';

-- ============================================================
-- 確認クエリ (実行後に手動確認)
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'tenant_settings_history' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'tenant_settings_history';
