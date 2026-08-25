-- src/lib/billing/migration_stripe_usage_reports_billed_quantity.sql
-- stripe_usage_reports に、Stripe へ実際に送った請求数量を残す。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。
--
-- ■ なぜ必要か
-- stripe_usage_reports は total_requests(倍率を掛ける前の件数)と
-- total_cost_cents(原価×マージン)しか記録していない。実際に
-- stripe.subscriptionItems.createUsageRecord() へ渡した quantity
-- (usage_logs.plan_multiplier で行ごとに重み付けした後の値)はどこにも
-- 残らないため、「Stripeにいくら請求したか」をDBだけでは再現できない。
-- 月次の突合(本番実データとの整合確認)の前提として、送信した数量そのものを
-- 保存する。
--
-- billing_status='reported' の usage_logs 行から billableUnits を再計算しても
-- 近い値は出せるが、fallbackMultiplier(月内で複数の値を取りうる)や
-- 集計時点の状態を正確に遡れないため、送信時点の値をそのまま残す方が確実。

ALTER TABLE stripe_usage_reports
  ADD COLUMN IF NOT EXISTS billed_quantity INTEGER;

COMMENT ON COLUMN stripe_usage_reports.billed_quantity IS
  'stripe.subscriptionItems.createUsageRecord() に実際に渡した quantity。'
  'usage_logs.plan_multiplier で行ごとに重み付けした加重合計を切り上げた値。'
  'NULL = 本カラム追加前に送信済みの既存行（送信は完了しているが値は遡れない）。';
