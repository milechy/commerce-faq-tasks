-- Phase41: Avatar Customization Studio
-- avatar_configs テーブル

CREATE TABLE IF NOT EXISTS avatar_configs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           VARCHAR(100) NOT NULL,
  image_url      TEXT,
  image_prompt   TEXT,
  voice_id       VARCHAR(100),
  voice_description TEXT,
  personality_prompt Text,
  behavior_description Text,
  emotion_tags   JSONB       NOT NULL DEFAULT '[]',
  lemonslice_agent_id VARCHAR(100),
  is_active      BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- アクティブ設定は各テナント1件のみ
CREATE UNIQUE INDEX IF NOT EXISTS idx_avatar_configs_active
  ON avatar_configs(tenant_id)
  WHERE is_active = true;

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION update_avatar_configs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_avatar_configs_updated_at
  BEFORE UPDATE ON avatar_configs
  FOR EACH ROW EXECUTE FUNCTION update_avatar_configs_updated_at();
