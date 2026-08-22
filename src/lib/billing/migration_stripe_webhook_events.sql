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

-- claimed_at: 「処理中」と「失敗して未完了」を区別するための処理権マーカー。
-- completed_at だけでは、同一イベントが並行到達したとき両方が「未完了だから再試行」と
-- 判断して副作用(Slack通知は非冪等)を二重実行してしまう。処理開始時に claimed_at を
-- 単一の条件付きUPSERTで奪い合わせ、獲得できたリクエストだけがハンドラを実行する。
-- 古い claimed_at (STALE_CLAIM_MINUTES 経過) は、処理中プロセスのクラッシュとみなして
-- 再獲得を許可する。これが無いと1度クラッシュしたイベントが永久に処理されなくなる。
ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
COMMENT ON COLUMN stripe_webhook_events.claimed_at IS
  '処理権を獲得した時刻。並行配信時の二重実行防止に使う。一定時間経過した claim は処理中プロセスの異常終了とみなし再獲得を許可する';
