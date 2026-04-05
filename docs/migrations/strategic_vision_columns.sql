-- Strategic Vision: 将来用カラム追加
-- 冪等マイグレーション（ADD COLUMN IF NOT EXISTS）
-- 実行タイミング: VPSで手動実行
-- 作成日: 2026-04-06

-- behavioral_events に将来用カラムを追加（NULLable）
ALTER TABLE behavioral_events ADD COLUMN IF NOT EXISTS device_type TEXT;
ALTER TABLE behavioral_events ADD COLUMN IF NOT EXISTS viewport_width INTEGER;
ALTER TABLE behavioral_events ADD COLUMN IF NOT EXISTS connection_type TEXT;
ALTER TABLE behavioral_events ADD COLUMN IF NOT EXISTS user_language TEXT;

-- chat_messages に将来用カラムを追加（NULLable）
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS psychology_principle_used TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS visitor_temp_score INTEGER;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sales_stage TEXT;
