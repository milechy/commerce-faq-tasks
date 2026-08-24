-- src/lib/billing/migration_usage_logs_plan_snapshot.sql
-- usage_logs にプラン倍率を「利用時点で焼き付ける」ための2列を追加する。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。
--
-- ■ なぜ必要か（適用前は請求が遡及する）
-- 適用前の stripeSync.ts は、月次バッチ実行時に `SELECT plan FROM tenants` で
-- 「その瞬間のプラン」を読み、その月の pending 行**すべて**に倍率を掛けていた
-- (stripeSync.ts の _reportTenantUsage)。つまり月中にプランが変わると、
-- 変更前に発生した利用分にまで新しい倍率が遡って適用される:
--   - enterprise(x2.5)で1か月使い、月末に free_ad(x0)へ落とす → その月の従量課金が全額0円
--   - 月中に growth へ上げる → 上げる前の利用分まで1.5倍で請求（後出しの値上げ）
-- 倍率確定が「その月に最初にバッチが成功した時点のプラン」に依存するため、
-- 請求の再現性も無い。テナント自身にプラン変更を開放する前提として、
-- 倍率は行ごとに利用時点で確定させる。
--
-- ■ NULL の意味（「未確定」であって「free_ad」ではない）
-- 本マイグレーション適用前に記録された既存行と、記録時にプランを確定できなかった行
-- (DB障害等)は NULL のままになる。NULL 行は stripeSync 側で従来どおり
-- tenants.plan 由来の倍率にフォールバックする(後方互換)。
-- ★ここを 0 や 'free_ad' の DEFAULT で埋めてはいけない★ — 埋めると
-- 「プラン未確定」と「無料プラン(x0)」が同じ値になり(CLAUDE.md 禁止20)、
-- 過去分の請求が静かに全額消える。DEFAULT を置かないのは意図的。
--
-- ■ CHECK 制約を張らない理由
-- tenants.plan 側の CHECK(migration_free_ad_plan.sql)は、未適用のままプラン値を
-- 増やすと本番だけ INSERT が落ちる事故を起こした。usage_logs は毎リクエスト
-- 書き込まれる最高トラフィックのテーブルであり、ここで同じ事故を起こすと
-- 利用記録そのものが失われる(= 請求不能)。プラン値の妥当性は書き込み側
-- (usageTracker.ts が queryTenantPlanResult の allowlist を通した値のみ渡す)で担保する。

ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS plan            TEXT,
  ADD COLUMN IF NOT EXISTS plan_multiplier NUMERIC(4,2);

COMMENT ON COLUMN usage_logs.plan IS
  'この行を記録した時点で確定していたテナントのプラン。'
  'NULL = 未確定(本カラム追加前の既存行、またはプラン取得失敗時)。'
  'NULL 行は stripeSync 側で tenants.plan 由来の倍率にフォールバックする。';

COMMENT ON COLUMN usage_logs.plan_multiplier IS
  'この行を記録した時点のプラン倍率(free_ad 0 / starter 1.0 / growth 1.5 / enterprise 2.5)。'
  'Stripe への請求数量はこの値で行ごとに確定し、後からのプラン変更は遡及しない。'
  'NULL = 未確定(plan カラムと同じ意味)。0 と NULL は別物なので DEFAULT を置かないこと。';
