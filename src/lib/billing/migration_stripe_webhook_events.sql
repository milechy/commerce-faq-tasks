-- Stripe Webhook イベントの冪等性テーブル
-- 同一 event.id の再送（Stripe側のretry）で副作用（Slack通知・DB更新）が重複しないようにする。
-- 実行: psql 'postgresql://postgres:...@localhost:5432/commerce_faq' -f migration_stripe_webhook_events.sql

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id   TEXT        PRIMARY KEY,
  event_type TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
