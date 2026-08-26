-- src/lib/billing/migration_stripe_usage_reports_dimension.sql
-- stripe_usage_reports に「どの課金次元の報告か」を持たせる。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。
--
-- ■ なぜ必要か
-- 基本料 + 込み枠 + 超過 で請求するプラン(Standard / Growth。
-- .claude/rules/billing.md §7)では、1テナント・1期間に対して
-- **テキスト超過**と**アバター超過**という2つの数量を、Stripe の別々の
-- subscription item へ送る。適用前のこの表は「1テナント・1期間 = 1つの数量」を
-- 前提に billed_quantity を1列だけ持っており、2つの報告を区別できない。
--
-- ■ なぜ「1行に2列を足す」ではなく「次元ごとに1行」なのか
-- この表の1行は単に数量の記録ではなく、**1回の createUsageRecord 呼び出しの
-- 顛末**を持っている: status(pending/sent/failed)・stripe_usage_record_id・
-- retry_count・last_error・idempotency_key。テキストは送れたがアバターは
-- Stripe エラーで落ちた、という状態は1行では表現できない
-- (status をどちらに倒しても、もう片方について嘘になる)。
-- 「1行 = 1回の送信」という既存の不変条件を保つ方が、リトライも突合も素直に動く。
--
-- 副次的な利点として、冪等キーが次元ごとに独立する
-- (`billing:<tenant>:<period>:text:<数量>` / `...:avatar:<数量>`)。
-- テキストだけが増えた日は、アバター側は前回と同じキーになって送信がスキップされ、
-- 変わっていない次元へ無駄な API 呼び出しをしない。
--
-- ■ DEFAULT 'total' にする理由(既存行と純従量プランを壊さない)
-- 純従量プラン(Starter / free_ad / Enterprise)は従来どおり1期間1数量しか
-- 作らないため 'total' のまま変わらない。適用前の既存行もすべて 'total' に
-- なり、billed_quantity を読む既存経路(billingReconciliation.ts)は
-- そのまま同じ値を読み続ける。
--
-- ■ CHECK 制約を張らない理由
-- feature_used の allowlist が「型 / DBのCHECK / NON_BILLABLE_FEATURES」の
-- 3箇所に分散し、片方だけ足すと INSERT が落ちて利用記録ごと消える、という
-- 事故をこのリポジトリは繰り返している(.claude/rules/billing.md §5)。
-- この列は請求の可否を決めない単なるラベルなので、同じ罠を新設しない。

ALTER TABLE stripe_usage_reports
  ADD COLUMN IF NOT EXISTS dimension TEXT NOT NULL DEFAULT 'total';

COMMENT ON COLUMN stripe_usage_reports.dimension IS
  'この行が記録している課金次元。'
  '''total'' = 純従量プラン(Starter/free_ad/Enterprise)の単一数量。'
  '''text'' = 込み枠プラン(Standard/Growth)のテキスト会話の込み枠超過分。'
  '''avatar'' = 同じくアバター分数の込み枠超過分。'
  '基本料は metered ではない定額priceで Stripe が自動請求するため、この表に行を作らない。'
  'billed_quantity はいずれも「その次元へ send した絶対値」で、プラン倍率は掛けていない'
  '(超過単価はプランごとに別の price として実在し、倍率はそちらに織り込まれている)。';

-- 突合(billingReconciliation.ts)は (tenant_id, period_yyyymm, dimension) ごとに
-- 直近の status='sent' 行を引く。既存の (tenant_id, period_yyyymm) インデックスに
-- 次元を足して、次元別の絞り込みまでインデックスで効かせる。
CREATE INDEX IF NOT EXISTS idx_stripe_usage_reports_tenant_period_dimension
  ON stripe_usage_reports(tenant_id, period_yyyymm, dimension);
