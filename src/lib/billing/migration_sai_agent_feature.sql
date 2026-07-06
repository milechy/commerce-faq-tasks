-- Phase3 (Sai課金配線): usage_logs.feature_used の CHECK 制約を拡張
-- 追加: sai_agent
--
-- あわせて、既にコード上で使われているが制約に含まれておらず
-- INSERTがサイレントに失敗していた値も追加する(2026-07-06確認: 本番DBのCHECK制約に
-- option_service / premium_avatar_generation / admin_agent が含まれていなかった)。

ALTER TABLE usage_logs DROP CONSTRAINT IF EXISTS usage_logs_feature_used_check;

ALTER TABLE usage_logs ADD CONSTRAINT usage_logs_feature_used_check
  CHECK (feature_used IN (
    'chat',
    'avatar',
    'voice',
    'admin_guide',
    'avatar_config_image',
    'avatar_config_voice',
    'avatar_config_prompt',
    'avatar_config_test',
    'anam_session',
    'feedback_ai',
    'book_analysis',
    'book_structurize',
    'option_service',
    'premium_avatar_generation',
    'admin_agent',
    'sai_agent'
  ));
