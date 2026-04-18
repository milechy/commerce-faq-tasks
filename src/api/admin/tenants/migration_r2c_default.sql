-- Phase66: r2c_default 仮想テナント追加 + carnation is_default アバター移行
-- 背景: avatar_configs.tenant_id='carnation' に is_default=true の18体が混在しており
--       livekitTokenRoutes の Q2 クエリ (OR is_default=true) 経由でクロステナント誤表示が発生。
--       専用テナント 'r2c_default' に分離することで構造的に解消する。
--
-- 実行: psql 'postgresql://postgres:hezdus-4jygWy-pyqrub@127.0.0.1:5432/commerce_faq' \
--           -f /opt/rajiuce/src/api/admin/tenants/migration_r2c_default.sql

BEGIN;

-- Step 1: r2c_default テナント追加
INSERT INTO tenants (id, name, plan, is_active, features, billing_enabled)
VALUES (
  'r2c_default',
  'R2C デフォルト (共用)',
  'enterprise',
  true,
  '{"avatar": true, "voice": false, "rag": false}'::jsonb,
  false
)
ON CONFLICT (id) DO NOTHING;

-- Step 2: is_default=true の18体を carnation → r2c_default に移行
UPDATE avatar_configs
SET tenant_id = 'r2c_default', updated_at = NOW()
WHERE is_default = true AND tenant_id = 'carnation';

COMMIT;

-- 検証クエリ (実行後に手動確認)
-- 期待: carnation/false=1, r2c_default/true=18
SELECT tenant_id, is_default, COUNT(*)
FROM avatar_configs
WHERE tenant_id IN ('carnation', 'r2c_default')
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT id, name, features, is_active, billing_enabled
FROM tenants
WHERE id IN ('carnation', 'r2c_default');
