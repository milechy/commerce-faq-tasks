-- Phase69-1: audit_logs テーブル（削除権 Right to Erasure）
-- actor_email NOT NULL: Supabase JWT に email が常時含まれる（空文字は許容）

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_email TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);
