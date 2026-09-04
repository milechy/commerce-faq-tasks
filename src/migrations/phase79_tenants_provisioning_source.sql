-- Phase79: tenants.provisioning_source（テナントの流入元）
-- 実行日: VPS で手動実行（★自動実行しない → CLAUDE.md 絶対にやってはいけないこと 8）
-- 対象: VPS PostgreSQL (65.108.159.161)
-- 要件: docs/WORDPRESS_PLUGIN_REQUIREMENTS.md D11 / §13.5
--
-- 設計意図:
--   これまで tenants にはどの経路で作られたかを示す列が無く、Super Admin側で
--   WordPress プラグイン経由のテナントを一覧から識別する手段が無かった。
--   WP-5(free_ad総量ガード)は発火実績を目で確認できないと運用できない
--   （禁止50: 監視対象が0件のときに「異常なし」と報告しない）。
--
-- ★未適用でも既存機能は壊れない★
--   DEFAULT 'manual' があるため、既存の POST /v1/admin/tenants 経由のINSERT
--   （列を明示しない）はこの列の存在を前提にしない。ただし
--   src/api/widget/wpProvisionRoutes.ts の completeWpProvisioning は
--   provisioning_source を明示INSERTするため、未適用のまま配備すると
--   WordPress プラグイン経由のテナント発行(POST /v1/public/wp/provision の
--   ポーリング完了パス)のみが 42703 で失敗する（既存の手動発行・配信経路は
--   影響を受けない）。

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS provisioning_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (provisioning_source IN ('manual', 'wordpress_plugin'));

COMMENT ON COLUMN tenants.provisioning_source IS
  'テナントの流入元。manual = Super Admin画面/APIからの手動作成、wordpress_plugin = WordPress プラグインのセルフサインアップ(POST /v1/public/wp/provision)経由。D11(§13.5)の識別・総量ガード監視に使う。';
