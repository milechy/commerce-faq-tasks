

# テナント設計 – マルチテナント Commerce-FAQ

このプロジェクトは最初から **マルチテナント** を前提にしています。

## テナント ID の扱い

- 文字列ベースの `tenant_id` / `tenantId`
- 例: `demo`, `shop-a`, `shop-b`

### DB 上の扱い

- `faq_docs.tenant_id`
- `faq_embeddings.tenant_id`
- （Elasticsearch）`faqs.tenant_id`

基本的に、**すべてのデータに `tenant_id` が付く** ことで論理的な分離を実現しています。

### API 上の扱い

- `/agent.search`
  - リクエストボディに `tenantId` を渡す
- `/admin/faqs` 系
  - クエリパラメータ `tenantId` を利用

今後、`x-tenant-id` ヘッダなどで指定する方式に統一することも可能です。

## 分離保証

- 検索クエリでは必ず `tenant_id = $tenantId` でフィルタ
- Admin API でも `tenantId` をキーにして WHERE 句を構築
- テナントをまたいだ閲覧 / 編集が起こらないように設計

## 将来の拡張

- 専用テーブル `tenants` を追加し、以下を管理することを想定:
  - テナント名 / 表示名
  - プラン / 課金情報
  - 担当コンサルタント（心理学 x 営業パートナー）
- Notion など外部ナレッジソースとのリンク先もテナント単位で管理

## 会話フローテンプレートとの関係

将来的に、テナントごとに **会話フローテンプレート** を持ち、
パートナーがクライアントごとにトークスクリプトをチューニングするモデルを想定しています。

その場合:

- `flow_templates` のようなテーブルを追加
- `tenant_id` + `template_id` 単位で会話フロー定義を保存
- `/agent.search` の Planner / Synthesis が、テナントごとのテンプレートを読み込み、
  セールス寄り / FAQ 寄り / クロージング重視 などを切り替える

本ドキュメントでは RAG とテナント分離までをカバーし、
会話フローテンプレートは Phase8 以降の仕様として扱います。