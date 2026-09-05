# Lane 2 (API) Agent Memory

> scope: project (git管理)
> 対象: src/, avatar-agent/
> 初期化: 2026-06-04 (Phase 1-G: GID 1214886037602478)

## API設計パターン

- [未認証OAuthのstate(CSRF)を新規テーブル無しで実装するパターン (2026-09-05)](pattern_stateless_oauth_csrf_state.md) — 自己完結・署名付きトークン(payload+purposeTag付きHMAC、timingSafeEqual比較)。「新規ファイルはこの2つのみ」制約下でのCSRF対策に再利用可
- [Shopify settings routes暫定認証とsurface設計](project_shopify_settings_routes_stopgap_auth.md) — タスク03(OAuth)で置き換える認証関数の契約とwidget_themeフラットキー設計の理由
- [既存purgeTenantChatData再利用時はdb引数を完全なPool型にする (2026-09-05)](pattern_purge_tenant_reuse_needs_full_pool.md) — Pick<Pool,"query">だとconnect()が無く型エラー。トランザクション系ヘルパー再利用時の型設計
- [秘密列SELECTは2ファイル制約下では新規ファイル内に閉じる (2026-09-05)](pattern_narrow_secret_column_select_inline.md) — 既存リポジトリが意図的に除外する秘密列(暗号化トークン等)への新規アクセスは、既存ファイルを増改築せずタスク新規ファイル内の最小SELECTで済ませる
- [実機確認できない第三者APIは1箇所の定数に閉じて暫定実装と明記する (2026-09-05)](pattern_unconfirmed_third_party_api_single_edit_point.md) — Shopify App Events API等「フィールド名を推測で書かない」規定と実装継続の両立パターン

## Gate失敗パターン

(まだ記録なし。Gate失敗のroot causeを発見したらここに追記する)

## プロジェクト固有の罠

- [Shopify inflow_source vs provisioning_source (2026-09-05)](trap_shopify_inflow_source_vs_provisioning_source.md) — inflow_source列は作られず、PR #1228でprovisioning_sourceに一本化解消済み。以後は必ずprovisioning_sourceを使う

## 参照ドキュメント

- `docs/24H_LOOP_LEARNING_INTEGRATION.md` — メモリ4層設計
- `CLAUDE.md §Anti-Slop` — ragExcerpt制限・tenantId取得ルール
