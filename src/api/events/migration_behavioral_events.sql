-- Phase55: 行動イベントレイヤー — behavioral_events テーブル

CREATE TABLE IF NOT EXISTS behavioral_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'page_view', 'scroll_depth', 'idle_time', 'product_view',
    'exit_intent', 'chat_open', 'chat_message', 'chat_conversion'
  )),
  event_data JSONB DEFAULT '{}',
  page_url TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_be_tenant_created ON behavioral_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_be_session ON behavioral_events(session_id);
CREATE INDEX IF NOT EXISTS idx_be_visitor ON behavioral_events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_be_type ON behavioral_events(event_type);
