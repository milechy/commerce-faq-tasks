-- src/api/admin/tenants/migration_free_ad_plan.sql
-- Asana 1217759064329998: free_ad(広告原資の無料プラン)を tenants.plan の
-- CHECK 制約に追加する。starter より下の最下段。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。適用しないまま
-- PATCH /v1/admin/tenants/:id で plan='free_ad' を送ると、アプリ側のZod
-- バリデーション(src/api/admin/tenants/routes.ts の planValues)は通過するが、
-- このCHECK制約により INSERT/UPDATE がDBエラーで失敗する。

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;

ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check
  CHECK (plan IN ('free_ad', 'starter', 'growth', 'enterprise'));

COMMENT ON COLUMN tenants.plan IS
  'free_ad(広告原資の無料プラン・最下段) / starter / growth / enterprise。'
  '既定はstarter。fail-safe時の落とし先は free_ad'
  '(src/lib/billing/planFeatures.ts の queryTenantPlan)。';
