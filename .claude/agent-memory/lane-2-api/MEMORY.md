# Lane 2 (API) Agent Memory

> scope: project (git管理)
> 対象: src/, avatar-agent/
> 初期化: 2026-06-04 (Phase 1-G: GID 1214886037602478)

## API設計パターン

- [Shopify settings routes暫定認証とsurface設計](project_shopify_settings_routes_stopgap_auth.md) — タスク03(OAuth)で置き換える認証関数の契約とwidget_themeフラットキー設計の理由

## Gate失敗パターン

(まだ記録なし。Gate失敗のroot causeを発見したらここに追記する)

## プロジェクト固有の罠

- [Shopify inflow_source vs provisioning_source (2026-09-05)](trap_shopify_inflow_source_vs_provisioning_source.md) — inflow_source列は作られず、PR #1228でprovisioning_sourceに一本化解消済み。以後は必ずprovisioning_sourceを使う

## 参照ドキュメント

- `docs/24H_LOOP_LEARNING_INTEGRATION.md` — メモリ4層設計
- `CLAUDE.md §Anti-Slop` — ragExcerpt制限・tenantId取得ルール
