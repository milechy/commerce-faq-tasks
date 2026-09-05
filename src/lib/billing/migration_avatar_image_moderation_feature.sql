-- src/lib/billing/migration_avatar_image_moderation_feature.sql
-- COPY-1: usage_logs.feature_used の CHECK 制約を拡張
-- 追加: avatar_image_moderation（アバター参照画像アップロードのGemini著作権/NSFWモデレーション、
-- imageContentGuard.ts）。原価可視化のみが目的でNON_BILLABLE_FEATURESに入れる
-- (テナントは既にアバターカスタマイズ自体の課金対象であり、安全チェック自体を二重請求しない)。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやっては
-- いけないこと8: DB migration を自動実行しない)。適用しないまま
-- trackUsage({ featureUsed: 'avatar_image_moderation' }) を書き込むと、この
-- CHECK制約によりINSERTがDBエラーで失敗する(migration_agent_search_feature.sqlと同じ経路)。

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
    'admin_option_estimator',
    'agent_search',
    'avatar_image_moderation'
  ));
