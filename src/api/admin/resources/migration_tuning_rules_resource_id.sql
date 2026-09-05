-- 資料オファー機能: tuning_rules に資料オファーとの紐付けを追加
--
-- tuning_rules 側ではなくこのディレクトリに置く理由: 新機能(資料オファー)のための
-- カラム追加であり、所有テーブル側ではなく機能側に置く規約
-- （前例: src/agent/judge/migration_tuning_rules_judge.sql）。

ALTER TABLE tuning_rules
  ADD COLUMN IF NOT EXISTS resource_id UUID REFERENCES tenant_resources(id) ON DELETE SET NULL;

COMMENT ON COLUMN tuning_rules.resource_id IS
  'このルールが提案として資料オファーを伴う場合の tenant_resources.id。資料が削除されると NULL に戻る。
既存の tuningRulesRepository.ts の SELECT はこのカラムを未取得（後続フェーズで対応）。';
