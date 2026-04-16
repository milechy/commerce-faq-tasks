-- Phase64修正: デフォルトアバターをアクティブ制約から除外
-- 旧: UNIQUE(tenant_id) WHERE is_active = true
-- 新: UNIQUE(tenant_id) WHERE is_active = true AND (is_default = false OR is_default IS NULL)
DROP INDEX IF EXISTS idx_avatar_configs_active;
CREATE UNIQUE INDEX idx_avatar_configs_active
  ON avatar_configs (tenant_id)
  WHERE is_active = true AND (is_default = false OR is_default IS NULL);

-- デフォルトアバター18体をアクティブ化
UPDATE avatar_configs SET is_active = true WHERE is_default = true;
