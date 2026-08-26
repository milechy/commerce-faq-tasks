-- GID 1217860755860341: 同期失敗(failed)がリロードで画面から消え、リコンサイル経路も無い
--
-- syncSubscriptionForTenant の結果は従来レスポンスにしか載らなかった(billing_sync)。
-- 「プランはCOMMIT済み・Stripe同期だけ失敗」というテナントに最も見えてほしくない
-- 状態が、コンポーネントのstateだけに保持されていたため、画面をリロードすると
-- 警告そのものが跡形もなく消えていた(2026-08-26レビュー是正)。
--
-- 直近の同期結果をtenants自身に焼き付け、リロードを跨いでもUIが復元できるようにする。
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS billing_sync_status TEXT,
  ADD COLUMN IF NOT EXISTS billing_sync_at TIMESTAMPTZ;
