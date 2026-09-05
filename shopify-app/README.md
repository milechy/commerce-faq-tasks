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
├── app/               # 埋め込み管理画面（React + Vite + App Bridge、Shopify Admin 内で表示）
│   ├── index.html     # App Bridge スクリプトタグ + meta[shopify-api-key]
│   ├── package.json   # 独立 package.json（依存未解決。npm install は人間が後で実施）
│   └── src/           # 接続状態表示・表示面選択UI・次にやること導線（下記参照）
└── extensions/        # Theme App Extension（App Embed Block）— 別タスクで実装
```

## `app/`（埋め込み管理画面）の実装状況

Asana GID 1218199817782431 で実装済み。以下の画面を持つ薄い React SPA（Vite ビルド）。

- **接続状態表示**（`ConnectionStatusCard`）: テナントID・現在のプラン・稼働可否
  （`GET /v1/public/shopify/settings` を呼ぶだけ。FR-09）
- **表示面選択UI**（`SurfaceSelector`）: 商品ページ/カート/配送ポリシーのチェックボックス
  （`PATCH /v1/public/shopify/settings` を呼ぶだけ。FR-06〜FR-08。
  **面の詳細選択の真実はここ** — Theme App Extension 側には持たせない。D18）
- **次にやること導線**（`NextStepsCard`）: FAQ登録は CopilotUI（`admin.r2c.biz/copilot-preview`）への
  リンクのみ。ここで FAQ登録・有人対応・課金操作を再実装しない（FR-12）
- **未接続時の案内**（`NotConnectedBanner`）: 1箇所に限定して表示（FR-10）

ロジック・プロンプト・指示ルールは一切持たず、すべて既存バックエンドAPI
（`src/api/widget/shopifySettingsRoutes.ts`）呼び出しに留めている（D9）。
`src/` の型は直接 import せず、`app/src/types.ts` に契約を手動で薄く再定義している（§3.2）。

**この環境で未実施（人間が後で実施）**:

- `npm install`（Partner Dashboard 認証・実際の `@shopify/app-bridge-react` 解決が必要なため未実施。
  ロックファイルも生成していない）
- `index.html` の `meta[shopify-api-key]` / `shopify.app.toml` の `client_id` の実値差し替え
- `shopify app dev` / `shopify app build` / `shopify app deploy` の実行
- **タスク03（App Bridge Token Exchange）完了後の認証方式差し替え**:
  現状 `app/src/lib/shopifySession.ts` は URL クエリパラメータ（`shop` / `tenant_id`）から
  値を読むだけの暫定実装。`shopifySettingsRoutes.ts` の `authenticate()` も同様に
  ヘッダ照合のみの暫定実装であり、両者はタスク03でセッショントークンベースの方式に
  置き換える前提でペアになっている

## 今後の作業（別タスク）

- Theme App Extension（`extensions/`）: App Embed Block によるウィジェット注入
  （`docs/SHOPIFY_APP_REQUIREMENTS.md` §4.2 FR-05〜FR-08）
- サーバ側の OAuth・Webhook・設定同期エンドポイントは本体の `src/api/widget/` 配下に実装する
  （このディレクトリではない。同 §5.1・§11.1。OAuth・設定APIは既に実装済み）

## セットアップ（人間が実施）

- Shopify Partner Dashboard でのアプリ作成・`client_id` の取得
- `shopify.app.toml` の `client_id` / `application_url` / webhook URL のプレースホルダ差し替え
- `app/index.html` の `meta[shopify-api-key]` のプレースホルダ差し替え
- `npm install`（ルート・`app/` それぞれ、または `shopify app init` によるテンプレート再生成）
- Shopify CLI での `shopify app dev` / `shopify app deploy` の実行

詳細な要件・受け入れ条件は `docs/SHOPIFY_APP_REQUIREMENTS.md` を参照。
