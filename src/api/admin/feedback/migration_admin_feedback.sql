-- Phase43: admin_feedback テーブル
-- 構造化フィードバック管理（チケットシステム）
-- 既存の feedback_messages テーブル（チャット）とは別システム

CREATE TABLE IF NOT EXISTS admin_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_email TEXT,
  message TEXT NOT NULL,
  ai_response TEXT,
  ai_answered BOOLEAN DEFAULT false,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'reviewed', 'needs_improvement', 'resolved')),
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('operation_guide', 'feature_request', 'bug_report', 'knowledge_gap', 'other')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high')),
  admin_notes TEXT,
  linked_knowledge_gap_id UUID REFERENCES knowledge_gaps(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_admin_feedback_tenant_id ON admin_feedback(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_feedback_status ON admin_feedback(status);
CREATE INDEX IF NOT EXISTS idx_admin_feedback_created_at ON admin_feedback(created_at DESC);

-- 自動更新トリガー
CREATE OR REPLACE FUNCTION update_admin_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_admin_feedback_updated_at
  BEFORE UPDATE ON admin_feedback
  FOR EACH ROW EXECUTE FUNCTION update_admin_feedback_updated_at();
