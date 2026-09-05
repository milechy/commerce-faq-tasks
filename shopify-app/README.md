# shopify-app/

R2C（`commerce-faq-tasks`）の Shopify アプリ「R2C – AI Sales Concierge」の Shopify CLI アプリプロジェクト。

**専用リポジトリは作らず、本体リポジトリ内にこのディレクトリとして配置している**
（`docs/SHOPIFY_APP_REQUIREMENTS.md` D11）。`admin-ui/` と同じ思想 —
独立した `package.json` / 独立した `node_modules` / 独立ビルド・独立デプロイ — で運用する。

## 位置づけ

- **root の Gate（`pnpm verify` などの Gate 1〜3）の対象外。** root の `package.json` /
  `pnpm-workspace.yaml` からは独立しており、root の CI はこのディレクトリを検査しない。
- **デプロイは `shopify app deploy`（Shopify CLI）のみ。** `SCRIPTS/deploy-vps.sh` とは完全に別系統。
- `shopify-app/app/`（埋め込み管理画面）から `src/` の型・スキーマを直接 import しない
  （デプロイ物が分かれるため。共有したい契約は API 経由・Zod スキーマ等で合わせる）。

## ディレクトリ構成

```
shopify-app/
├── shopify.app.toml   # Shopify CLI アプリ設定（雛形。client_id 等はプレースホルダ）
├── package.json       # 独立 package.json（依存は未解決。npm install は人間が後で実施）
├── app/               # 埋め込み管理画面（Remix/App Bridge、Shopify Admin 内で表示）— 別タスクで実装
└── extensions/        # Theme App Extension（App Embed Block）— 別タスクで実装
```

## 今後の作業（別タスク）

- 埋め込み管理画面（`app/`）: 接続状態表示・表示面選択 UI・課金状態表示など
  （`docs/SHOPIFY_APP_REQUIREMENTS.md` §4.3 FR-09〜FR-12）
- Theme App Extension（`extensions/`）: App Embed Block によるウィジェット注入
  （同 §4.2 FR-05〜FR-08）
- サーバ側の OAuth・Webhook・設定同期エンドポイントは本体の `src/api/widget/` 配下に実装する
  （このディレクトリではない。同 §5.1・§11.1）

## セットアップ（人間が実施）

このタスクではディレクトリ構成とファイルの雛形のみを用意しており、以下は未実施:

- Shopify Partner Dashboard でのアプリ作成・`client_id` の取得
- `shopify.app.toml` の `client_id` / `application_url` / webhook URL のプレースホルダ差し替え
- `npm install`（または `shopify app init` によるテンプレート再生成）
- Shopify CLI での `shopify app dev` / `shopify app deploy` の実行

詳細な要件・受け入れ条件は `docs/SHOPIFY_APP_REQUIREMENTS.md` を参照。
