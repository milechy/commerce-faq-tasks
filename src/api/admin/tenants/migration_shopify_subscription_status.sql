-- src/api/admin/tenants/migration_shopify_subscription_status.sql
-- Shopify Billing (AppSubscription) の課金承認状態を tenants に焼き付け、
-- suspensionGate.ts の追加ゲート判定材料にする(D19: docs/SHOPIFY_APP_REQUIREMENTS.md)。
--
-- ★なぜ既存の subscription_status(Stripe用)に相乗りしないか★
-- tenants.subscription_status は Stripe subscription の生 status を保持する列で、
-- Shopify 経由テナント(provisioning_source='shopify_app')は Stripe subscription を
-- そもそも持たない(課金は Shopify Billing API 側で完結する)。同じ列に Shopify の
-- AppSubscription status(PENDING/ACTIVE/CANCELLED/FROZEN 等)を書くと、
-- suspensionGate.ts 既存の SUSPENDED_STATUSES 判定(Stripe固有の語彙: unpaid/canceled/
-- incomplete_expired/paused)と語彙が衝突し、意図せず誤判定を起こす。独立した列で持つ。
--
-- ★このmigrationだけでは自動更新されない(未実装の範囲)★
-- Shopify の app_subscriptions/update webhook 受信、または OAuth コールバック後の
-- ポーリングによってこの列を更新する仕組みは本タスクの範囲外。したがって
-- provisioning_source='shopify_app' のテナントは、当面 shopify_subscription_status が
-- NULL または 'pending' のまま留まり得る。suspensionGate.ts 側は
-- 「'active' 以外(NULL/pending/cancelled/frozen 含む)はすべて suspended 相当」という
-- fail-safe(不明なら機能を開かない)で扱うため、この列を更新する仕組みが実装されるまで
-- Shopify 経由テナントのテキストチャットは稼働しない(意図した挙動。CLAUDE.md 禁止10:
-- 課金が成立しないまま費用が発生する操作を開放しない)。
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやっては
-- いけないこと8: DB migration を自動実行しない)。未適用時は suspensionGate.ts の
-- queryBillingAccess が 42703 を fail-open し(既存の subscription_status/delinquent_since
-- と同じ扱い)、Shopify 以外のテナントを含め全テナントのゲートが従来どおり無効化される
-- ため、コードのデプロイが先行しても本番は壊れない。

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS shopify_subscription_status TEXT
  CHECK (shopify_subscription_status IS NULL OR shopify_subscription_status IN ('pending', 'active', 'cancelled', 'frozen'));

COMMENT ON COLUMN tenants.shopify_subscription_status IS
  'Shopify Billing AppSubscription の課金承認状態(pending/active/cancelled/frozen)。NULL=未記録。'
  'provisioning_source=''shopify_app'' のテナントのみ意味を持つ。この列を実際に更新する'
  'webhook/ポーリングは未実装(D19実装時点)のため、実装されるまでは NULL または pending の'
  'まま留まり、suspensionGate.ts により機能停止(suspended相当)として扱われる。'
  '判定材料: src/lib/billing/suspensionGate.ts。';
