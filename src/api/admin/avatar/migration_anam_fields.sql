-- Phase42: Anam.ai移行 — avatar_configsテーブルにAnamフィールド追加
ALTER TABLE avatar_configs
  ADD COLUMN IF NOT EXISTS anam_avatar_id    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS anam_voice_id     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS anam_persona_id   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS anam_llm_id       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS avatar_provider   VARCHAR(20) NOT NULL DEFAULT 'lemonslice';
