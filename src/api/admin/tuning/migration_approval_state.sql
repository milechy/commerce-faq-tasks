-- D8: tuning_rules の承認状態の意味を固定する（学習ループ要件定義 docs/LEARNING_LOOP_REQUIREMENTS.md §9 D8）
--
-- 列は追加しない・DEFAULT も変更しない。列そのものは既に存在する
-- (is_active: migration.sql, status: migration_kpi_outcome.sql)。
-- このマイグレーションは意味を COMMENT で明文化するだけ。
--
-- 決定事項:
--   is_active が唯一の真実(本番の応答方針に入るかどうかはこの列だけで決まる)。
--   status は承認判断の記録(pending=未判断 / active=人が承認した / rejected=人が却下した)。
--   単独では効力を持たない。
-- 不変条件（コード側 approveTuningRule / rejectTuningRule / updateRule の3箇所で強制）:
--   status='active'   ⇒ is_active=true
--   status='rejected' ⇒ is_active=false
--   status='pending'  は is_active を拘束しない
--
-- データ移行は不要（本番実測 2026-08-23: tuning_rules 全7件が status='pending' で
-- 不整合0件。status='active' かつ is_active<>true、または status='rejected' かつ
-- is_active=true の行は存在しない）。

COMMENT ON COLUMN tuning_rules.is_active IS
  'D8: 唯一の真実。true のときだけ getActiveRulesForTenant() が本番プロンプトへ注入する。';

COMMENT ON COLUMN tuning_rules.status IS
  'D8: 承認判断の記録のみ（pending=未判断 / active=承認済み / rejected=却下済み）。単独では効力を持たない。是正: approveTuningRule/rejectTuningRule/updateRule が is_active との同時更新を保証する。';
