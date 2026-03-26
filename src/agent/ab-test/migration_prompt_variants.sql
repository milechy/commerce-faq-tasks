-- Phase46: A/Bテスト基盤 - system_prompt_variants & chat_sessionsへのvariant記録

-- tenantsテーブルにsystem_prompt_variants JSONB追加
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS system_prompt_variants JSONB DEFAULT '[]';
-- 構造: [{ "id": "variant_a", "name": "標準版", "prompt": "...", "weight": 70 }, { "id": "variant_b", "name": "積極版", "prompt": "...", "weight": 30 }]
-- weightの合計は100

-- chat_sessionsにvariant記録カラム追加
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS prompt_variant_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS prompt_variant_name TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_variant ON chat_sessions(prompt_variant_id);
