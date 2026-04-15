-- Phase6-B: チューニングルール LLMテスト返答 採用カラム追加

ALTER TABLE tuning_rules ADD COLUMN IF NOT EXISTS approved_responses JSONB DEFAULT '[]'::jsonb;
COMMENT ON COLUMN tuning_rules.approved_responses IS 'LLMテスト返答のうちユーザーが採用したもの [{text, reason, approved_at, style}]';
