-- src/api/admin/tenants/migration_standard_plan.sql
-- Standard(¥9,800/月)を tenants.plan の CHECK 制約に追加する。
-- starter と growth の「間」に入る段で、R2C の既定アバターの利用を開放し、
-- 自社アバターの作成(avatar_customize)は Growth 以上に残す。
-- 価格・課金単位の確定内容は .claude/rules/billing.md §7 を参照。
--
-- migration_free_ad_plan.sql と同じく DROP + ADD で制約を丸ごと置き換える。
-- 本ファイルは free_ad 追加分を含んだ最終形なので、適用順は
-- migration_free_ad_plan.sql より後でなければならない
-- (先に適用すると free_ad が制約から落ちる)。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。適用しないまま
-- PATCH /v1/admin/tenants/:id や PUT /v1/admin/my-tenant/plan で plan='standard'
-- を送ると、アプリ側のZodバリデーション(src/api/admin/tenants/routes.ts の
-- planValues)は通過するが、このCHECK制約により UPDATE がDBエラーで失敗する
-- (CLAUDE.md 禁止55: CHECK 未適用は本番だけ DB エラー)。

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;

ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check
  CHECK (plan IN ('free_ad', 'starter', 'standard', 'growth', 'enterprise'));

COMMENT ON COLUMN tenants.plan IS
  'free_ad(広告原資の無料プラン・最下段) / starter / standard / growth / enterprise。'
  'standard は starter と growth の間(既定アバターの利用可・自社カスタム作成は不可)。'
  '既定はstarter。fail-safe時の落とし先は free_ad'
  '(src/lib/billing/planFeatures.ts の queryTenantPlan)。';
