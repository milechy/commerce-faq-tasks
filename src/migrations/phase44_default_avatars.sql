-- Phase44: デフォルトアバター対応
ALTER TABLE avatar_configs ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;
ALTER TABLE avatar_configs ADD COLUMN IF NOT EXISTS default_template_id VARCHAR(50);
ALTER TABLE avatar_configs ADD COLUMN IF NOT EXISTS default_voice_id TEXT;
ALTER TABLE avatar_configs ADD COLUMN IF NOT EXISTS default_personality_prompt TEXT;
ALTER TABLE avatar_configs ADD COLUMN IF NOT EXISTS default_name VARCHAR(100);

-- default_template_id にユニーク制約（テナント内で重複防止）
CREATE UNIQUE INDEX IF NOT EXISTS idx_avatar_configs_default_template
  ON avatar_configs(tenant_id, default_template_id)
  WHERE default_template_id IS NOT NULL;
