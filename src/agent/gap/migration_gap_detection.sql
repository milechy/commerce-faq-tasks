-- Phase46: knowledge_gaps テーブル拡張（冪等）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='knowledge_gaps' AND column_name='frequency') THEN
    ALTER TABLE knowledge_gaps ADD COLUMN frequency INTEGER DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='knowledge_gaps' AND column_name='detection_source') THEN
    ALTER TABLE knowledge_gaps ADD COLUMN detection_source TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='knowledge_gaps' AND column_name='recommended_action') THEN
    ALTER TABLE knowledge_gaps ADD COLUMN recommended_action TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='knowledge_gaps' AND column_name='recommendation_status') THEN
    ALTER TABLE knowledge_gaps ADD COLUMN recommendation_status TEXT DEFAULT 'pending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='knowledge_gaps' AND column_name='last_detected_at') THEN
    ALTER TABLE knowledge_gaps ADD COLUMN last_detected_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gaps_tenant_status ON knowledge_gaps(tenant_id, recommendation_status);
CREATE INDEX IF NOT EXISTS idx_gaps_frequency ON knowledge_gaps(frequency DESC);
CREATE INDEX IF NOT EXISTS idx_gaps_detection ON knowledge_gaps(detection_source);
