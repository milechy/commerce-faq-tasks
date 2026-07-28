-- GID 1216944003337186: usage_logs.feature_used の CHECK 制約を拡張
-- 追加: admin_tuning, admin_ai_assist, admin_engagement_suggest, admin_option_estimator
-- （いずれも管理系LLM機能。billable=false で原価可視化のみ、Stripe請求数量には含めない）

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
    'sai_agent',
    'admin_tuning',
    'admin_ai_assist',
    'admin_engagement_suggest',
    'admin_option_estimator'
  ));
