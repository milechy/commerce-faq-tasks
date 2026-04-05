-- Phase53: usage_logs.feature_used の CHECK 制約を拡張
-- 既存: ('chat', 'avatar', 'voice')
-- 追加: avatar_config_*, anam_session, feedback_ai, book_analysis, book_structurize, admin_guide

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
    'book_structurize'
  ));
