-- Phase50: avatar_configs に agent_prompt / agent_idle_prompt カラム追加
-- LemonSlice AvatarSession に渡すアバター固有の動作・アイドルプロンプトを DB に保持する

ALTER TABLE avatar_configs
  ADD COLUMN IF NOT EXISTS agent_prompt      TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS agent_idle_prompt TEXT DEFAULT NULL;
