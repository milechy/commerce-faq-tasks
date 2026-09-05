-- src/lib/billing/migration_usage_logs_shopify_event.sql
-- Asana 1218199856712585: Shopify App Events API への計上報告可否を突合するためのフラグを追加する。
-- 要件: docs/SHOPIFY_APP_REQUIREMENTS.md §5.2 / D3
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。
--
-- ■ なぜ必要か
-- Shopify 経由テナントの請求起点は Shopify Billing の App Events API のメーター報告であり、
-- 既存 Stripe 課金レール(stripeSync.ts / computeExpectedBilling)とは独立させる(D3)。
-- App Events API は同期的な課金エラーを返さない(常に202を返し、検証失敗は Partner Dashboard の
-- Logs でのみ確認できる)ため、計上の失敗が沈黙する構造になりうる(CLAUDE.md 禁止41〜43と同型)。
-- usage_logs 側にこのフラグを持たせることで、Shopify 経由テナントの usage_logs 件数と
-- Shopify 側への報告件数(このフラグがNOT NULLな行数)を突合し、報告漏れを検知できるようにする。
--
-- ■ NULL の意味
-- NULL = 未報告(Shopify経由テナントでまだ報告していない行、またはそもそもShopify経由でない行)。
-- 報告済みになった時点でこのカラムに報告時刻を書き込む。他のフラグ列(billable 等)と異なり
-- BOOLEAN ではなく TIMESTAMPTZ にしているのは、「いつ報告したか」自体が突合(§5.2)に必要なため。
-- DEFAULT は置かない(既存行・Shopify経由でない行を「報告不要」の0件相当として静かに埋めない)。

ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS shopify_event_reported_at TIMESTAMPTZ;

COMMENT ON COLUMN usage_logs.shopify_event_reported_at IS
  'Shopify App Events API への報告に成功した時刻。NULL = 未報告(Shopify経由テナントでの報告待ち、'
  'またはShopify経由でない行)。Shopify経由テナントの usage_logs 件数とこの列がNOT NULLな件数を'
  '突合し、報告漏れを検知する監視項目に使う(docs/SHOPIFY_APP_REQUIREMENTS.md §5.2)。';
