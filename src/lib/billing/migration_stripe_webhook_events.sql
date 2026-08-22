-- Stripe Webhook イベントの冪等性テーブル
-- 同一 event.id の再送（Stripe側のretry）で副作用（Slack通知・DB更新）が重複しないようにする。
-- 実行: psql 'postgresql://postgres:...@localhost:5432/commerce_faq' -f migration_stripe_webhook_events.sql

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id   TEXT        PRIMARY KEY,
  event_type TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2状態管理: INSERT時点(created_at)は「受信した」ことしか意味しない。
-- completed_at が NULL のまま再送されてきた場合は、前回ハンドラが失敗した
-- （または処理中にクラッシュした）とみなし、副作用を再試行する。
-- NULLのまま = 未完了、NOT NULL = ハンドラが最後まで成功した。
ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
COMMENT ON COLUMN stripe_webhook_events.completed_at IS
  '副作用(DB更新・Slack通知)の完了時刻。NULLは前回失敗/処理中を意味し、再送時に再試行を許可する';
