-- LP leads table: 見込み顧客の問い合わせを記録
-- Phase: LP

CREATE TABLE IF NOT EXISTS lp_leads (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  company     TEXT NOT NULL,
  site_url    TEXT NOT NULL,
  email       TEXT NOT NULL,
  industry    TEXT,
  message     TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lp_leads_email      ON lp_leads (email);
CREATE INDEX IF NOT EXISTS idx_lp_leads_created_at ON lp_leads (created_at DESC);
