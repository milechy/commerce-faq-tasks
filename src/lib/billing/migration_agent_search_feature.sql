-- src/lib/billing/migration_agent_search_feature.sql
-- GID [A2A-1a]: usage_logs.feature_used の CHECK 制約を拡張
-- 追加: agent_search（/agent.search・/agent/search の外部エージェント連携API。
-- これまで 'chat' に相乗りして計上していたが、他機能と原価・利用実績を混ぜずに
-- 可視化するため分離した。billable=trueのまま(NON_BILLABLE_FEATURESには入れない)。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやっては
-- いけないこと8: DB migration を自動実行しない)。適用しないまま
-- trackUsage({ featureUsed: 'agent_search' }) を書き込むと、このCHECK制約により
-- INSERT がDBエラーで失敗する(migration_admin_tooling_feature.sql と同じ経路)。

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
    'agent_search'
  ));
