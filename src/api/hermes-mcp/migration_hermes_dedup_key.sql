-- R6: tuning_rules に dedup_key を追加する(Hermes提案の冪等性)
-- (学習ループ要件定義 docs/LEARNING_LOOP_REQUIREMENTS.md §9 R6)
--
-- Hermes Agent(外部VPS)は同じ洞察を毎晩再提案しうる。Hermes側のSKILL.mdの規約では
-- dedup_key は洞察を要約したスラグ(例: tenant:carnation:warranty-period-upfront)で、
-- 同じ洞察なら毎回同じ値になることが前提。従来 hermes_strategy_proposals テーブルは
-- dedup_key で ON CONFLICT していたが、この提案は今後 tuning_rules に着地させる
-- (R6: 提案の受け皿を1つにする)。tuning_rules 既存の
-- (tenant_id, trigger_pattern) 一意制約だけに頼ると、trigger_pattern(=title)の
-- 言い回しが毎回微妙に変わるだけで別の提案として重複挿入されてしまうため、
-- Hermes 由来の行だけは dedup_key でも一意制約を持たせる。

ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tuning_rules_tenant_dedup_key
  ON tuning_rules (tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

COMMENT ON COLUMN tuning_rules.dedup_key IS
  'Hermes提案の冪等キー(同じ洞察は同じ値になる)。Judge由来・手動作成のルールでは常にNULL。';
