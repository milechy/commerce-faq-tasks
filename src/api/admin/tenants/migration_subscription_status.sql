-- src/api/admin/tenants/migration_subscription_status.sql
-- fix/unpaid-suspension [P0]: Stripe subscription の生 status を tenants に焼き付け、
-- 未払(past_due / unpaid / canceled)テナントの提供停止ゲートの判定材料にする。
--
-- ★なぜ tenants.is_active に相乗りしないか★
-- tenants.is_active は「super_admin による手動の有効/無効」を表す既存の運用フラグ
-- (livekitTokenRoutes / anamRoutes が tenant_inactive として参照)。ここに課金起点の
-- 停止を混ぜると、(a) 支払い回復時に自動で is_active を戻す処理が手動無効まで
-- 巻き戻す、(b) 手動無効の監査ログと課金停止が区別できなくなる、の2つの事故が起きる。
-- 課金起点の状態は独立した列で持ち、ゲートは plan + subscription_status +
-- delinquent_since から算出する(src/lib/billing/suspensionGate.ts)。
--
--   subscription_status … Stripe の customer.subscription.* が運ぶ status をそのまま格納。
--                         active / trialing / past_due / unpaid / canceled /
--                         incomplete / incomplete_expired / paused。NULL は「未記録」で、
--                         既存テナント(本migration適用前から居るテナント)は全員 NULL に
--                         なるため、resolver は NULL を「延滞なし=active」として扱うこと
--                         (NULL を suspended に倒すと全顧客が一斉に止まる)。
--   delinquent_since    … past_due に入った時刻。猶予期間(BILLING_PAST_DUE_GRACE_DAYS)を
--                         この時刻から計る。健全な status(active/trialing)へ回復したら
--                         webhook が NULL に戻す。past_due 継続中は最初の時刻を保持する
--                         (COALESCE で上書きしない)ため、猶予は「延滞開始からN日」で一貫する。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやっては
-- いけないこと8: DB migration を自動実行しない)。未適用でも webhook・ゲートの双方が
-- 42703 を fail-open する(subscription_status を書けない・読めない場合はゲート無効=
-- 従来どおり全提供)ため、コードのデプロイが先行しても本番は壊れない。適用後に
-- 初めて停止ゲートが有効化される。適用順の制約は無い(独立した ADD COLUMN)。

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_status TEXT,
  ADD COLUMN IF NOT EXISTS delinquent_since    TIMESTAMPTZ;

COMMENT ON COLUMN tenants.subscription_status IS
  'Stripe subscription の生status(active/trialing/past_due/unpaid/canceled/incomplete/'
  'incomplete_expired/paused)。NULL=未記録は「延滞なし」として扱う。提供停止ゲートの'
  '判定材料(src/lib/billing/suspensionGate.ts / stripeWebhook.ts)。';

COMMENT ON COLUMN tenants.delinquent_since IS
  'past_due に入った時刻。猶予期間(BILLING_PAST_DUE_GRACE_DAYS)の起点。'
  'active/trialing へ回復したら webhook が NULL に戻す。';
