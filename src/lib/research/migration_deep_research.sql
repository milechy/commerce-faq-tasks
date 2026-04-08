-- Phase60-C: deep_researchフラグ追加
-- features JSONBカラムにdeep_researchキーを追加（既存データはそのまま）
-- 既にfeaturesカラムがある前提（ない場合は先にALTER TABLEで追加）

-- 既存テナントのfeaturesにdeep_researchデフォルト値を設定（未設定のもののみ）
UPDATE tenants
SET features = COALESCE(features, '{}'::jsonb) || '{"deep_research": false}'::jsonb
WHERE NOT (features ? 'deep_research');
