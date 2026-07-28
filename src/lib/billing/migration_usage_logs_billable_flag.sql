-- GID 1216944003337186: usage_logs.billable フラグ追加
--
-- 管理系LLM機能（admin_tuning / admin_ai_assist / admin_engagement_suggest /
-- admin_option_estimator）や、既にchargeOneOffJpyで請求が完結しているsai_agentは、
-- 原価(cost_total_cents)はusage_logsに記録するが、Stripe請求数量
-- (stripeSync.ts の billedQuantity = usage_logs の行数ベース集計)には含めたくない。
--
-- billable=false の行は原価可視化のみに使い、stripeSync.ts の集計クエリから除外する。
-- 既存行は全て billable=true 相当として扱う（デフォルトtrue、既存の課金挙動を変えない）。

ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS billable BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_usage_logs_billable ON usage_logs(billable);
