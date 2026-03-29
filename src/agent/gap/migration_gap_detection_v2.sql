-- Phase46 Stream B: knowledge_gaps に suggested_answer カラムを追加（冪等）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='knowledge_gaps' AND column_name='suggested_answer') THEN
    ALTER TABLE knowledge_gaps ADD COLUMN suggested_answer TEXT;
  END IF;
END $$;
