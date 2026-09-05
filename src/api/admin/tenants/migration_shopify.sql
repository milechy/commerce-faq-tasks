-- src/api/admin/tenants/migration_shopify.sql
-- Asana 1218199856712585: Shopify アプリ連携用に tenants を拡張する。
-- 要件: docs/SHOPIFY_APP_REQUIREMENTS.md D15 / D16 / D19 / §5.1 / §5.3 / §11.1
--
-- 注意: 本マイグレーションは人間承認のうえ適用すること(CLAUDE.md 絶対にやって
-- はいけないこと8: DB migration を自動実行しない)。

-- ============================================================
-- Shopify OAuth 接続情報
-- ============================================================
--
-- shopify_access_token_encrypted は src/lib/crypto/textEncrypt.ts の encryptText で
-- 暗号化した値を保存する(src/api/admin/tenants/posthogRoutes.ts が
-- posthog_project_api_key_encrypted で使っている暗号化パターンと同じ)。
-- 平文のアクセストークンをDBに保存しない。

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS shopify_shop_domain             TEXT,
  ADD COLUMN IF NOT EXISTS shopify_access_token_encrypted  TEXT,
  ADD COLUMN IF NOT EXISTS shopify_scope                   TEXT,
  ADD COLUMN IF NOT EXISTS shopify_installed_at            TIMESTAMPTZ;

COMMENT ON COLUMN tenants.shopify_shop_domain IS
  'Shopify ストアの shop ドメイン(例: xxx.myshopify.com)。OAuth コールバック/HMAC検証済みWebhook由来の'
  'shop のみを真として書き込む。req.body 由来の値を信用しない(CLAUDE.md 禁止1)。';

COMMENT ON COLUMN tenants.shopify_access_token_encrypted IS
  'Shopify Admin API のアクセストークンを src/lib/crypto/textEncrypt.ts の encryptText で暗号化した値。'
  '平文のまま保存しない(posthog_project_api_key_encrypted と同じ暗号化パターン)。';

COMMENT ON COLUMN tenants.shopify_scope IS
  'OAuth 認可時に付与されたスコープ(スペース区切りの生文字列)。再認可要否の判定に使う。';

COMMENT ON COLUMN tenants.shopify_installed_at IS
  'Shopify アプリのインストール(OAuthコールバック完了)時刻。'
  'インストール=課金承認ではない点に注意(D19)。課金状態は suspensionGate.ts 側で別途判定する。';

-- ============================================================
-- テナント流入元(provisioning_source)への 'shopify_app' 追加
-- ============================================================
--
-- ★実装前確認で判明: 「テナント流入元を識別する列」は本タスク時点で新規ではなく、
-- src/migrations/phase79_tenants_provisioning_source.sql で
-- tenants.provisioning_source TEXT NOT NULL DEFAULT 'manual'
--   CHECK (provisioning_source IN ('manual', 'wordpress_plugin'))
-- として既に存在し、src/api/widget/wpProvisionRoutes.ts / src/api/admin/agent/actionExecutor.ts /
-- src/api/admin/tenants/routes.ts の SELECT で実運用されている。
-- docs/SHOPIFY_APP_REQUIREMENTS.md §11.1 は「実装コード上はまだ存在しないことを確認済み」と
-- 記載しているが、grep で確認した実コードと矛盾するため、本マイグレーションでは
-- 新規列 inflow_source を作らず(CLAUDE.md 禁止6: 同じ関心事を2列に複製しない)、
-- 既存の provisioning_source の CHECK 制約に 'shopify_app' を追加する形で対応する。
-- 既存の CHECK 拡張パターン(migration_free_ad_plan.sql → migration_standard_plan.sql の
-- DROP CONSTRAINT + ADD CONSTRAINT)に倣う。DEFAULT 'manual' は変更しないため既存行は壊れない。

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_provisioning_source_check;

ALTER TABLE tenants ADD CONSTRAINT tenants_provisioning_source_check
  CHECK (provisioning_source IN ('manual', 'wordpress_plugin', 'shopify_app'));

COMMENT ON COLUMN tenants.provisioning_source IS
  'テナントの流入元。manual = Super Admin画面/APIからの手動作成、'
  'wordpress_plugin = WordPress プラグインのセルフサインアップ(POST /v1/public/wp/provision)経由、'
  'shopify_app = Shopify アプリのインストール(OAuthコールバック)経由。'
  '既定は manual。D11(WordPress版)/ docs/SHOPIFY_APP_REQUIREMENTS.md §5.3 の識別・総量ガード監視に使う。';

-- ============================================================
-- GDPR shop/redact 削除保留(D15 / D16)
-- ============================================================
--
-- shop/redact はテナント全データの不可逆削除に相当するため、Webhook受信時点では
-- 「削除保留」としてマークするのみに留め、実際の削除は人間の承認操作を経て実行する
-- (CLAUDE.md 禁止8: 不可逆操作は人間承認)。
--
-- deletion_requested_at … shop/redact Webhook 受信時刻。この時刻+30日が対応期限。
--                         保留 0 件の状態を「異常なし」と表示しない(CLAUDE.md 禁止50)。
-- deletion_approved_at  … 人間が削除実行を承認した時刻。NULL = 未承認(保留中)。
-- deletion_approved_by  … 承認者の識別子(super_adminのユーザーID/メールアドレス等)。
--
-- deletion_requested_at IS NOT NULL かつ deletion_approved_at IS NULL の間に同一ストアが
-- 再インストールした場合は、この保留を解除(deletion_requested_at を NULL に戻す)して
-- 既存テナントを復元する(D16)。承認後(deletion_approved_at が入った後)の再インストールは
-- 新規テナントとして扱う。

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_approved_by  TEXT;

COMMENT ON COLUMN tenants.deletion_requested_at IS
  'Shopify shop/redact Webhook の受信時刻。NULL = 削除保留なし。'
  '対応期限はこの時刻+30日(D15)。同一ストアの再インストールで保留解除されるとNULLに戻る(D16)。';

COMMENT ON COLUMN tenants.deletion_approved_at IS
  '人間が shop/redact の実削除を承認した時刻。NULL = 未承認(保留中、または削除保留なし)。'
  '承認後にテナントの実データ削除処理を実行する(自動削除しない、CLAUDE.md 禁止8)。';

COMMENT ON COLUMN tenants.deletion_approved_by IS
  'shop/redact の実削除を承認した人間の識別子(例: super_admin のメールアドレス)。監査用。';
