

# NOTION_SYNC.md

Phase13 で実装した Notion 同期（FAQ / Products / LP Points / TuningTemplates）の仕様をまとめる。

## 概要

AaaS バックエンドは、Notion 上の 4 つのデータベースからコンテンツを同期し、PostgreSQL に保存する。

対象 DB:

- FAQ
- Products
- LP Points
- TuningTemplates（Clarify / Propose / Recommend / Close のテンプレ）

同期方式:

- `pnpm sync:notion` による手動同期
- 起動時の TuningTemplates 自動同期

## 共通仕様

### インテグレーション
利用する Notion Integration は **commerce-faq-phase13**。  
すべての DB をこのインテグレーションに接続する必要がある。

### 必須環境変数

```
NOTION_API_KEY=
NOTION_DB_FAQ_ID=
NOTION_DB_PRODUCTS_ID=
NOTION_DB_LP_POINTS_ID=
NOTION_DB_TUNING_TEMPLATES_ID=
```

### 取得ロジック

`NotionClient.queryDatabaseAll()` により:

- 全件取得（has_more を使ったページング）
- DB の data_source_id を自動解決
- 取得した JSON を repository 層の bulkUpsert に渡す

エラー時の例外は NotionClient 内でログ化。

---

# FAQ 同期仕様

FAQ DB の 1 行に必要なプロパティ:

- `Question` (title)
- `Answer` (rich_text)
- `Tags` (multi_select)
- `Slug` (formula or text)

同期後は PostgreSQL の `faq` テーブルに保存。

---

# Products 同期仕様

Products DB の 1 行に必要なプロパティ:

- `Name` (title)
- `Description` (rich_text)
- `Price` (number)
- `Slug` (text)

---

# LP Points 同期仕様

LP の訴求ポイントを外部化。

必要プロパティ:

- `Title` (title)
- `Body` (rich_text)
- `Order` (number)

---

# TuningTemplates 同期仕様

AI営業テンプレ（Clarify / Propose / Recommend / Close）のマスター。

必要プロパティ:

- `Phase` (select)
- `Intent` (text)
- `PersonaTags` (multi_select)
- `Template` (rich_text)

同期後は `salesTemplateProvider` にロードされ、Planner/SalesAgent が利用。

---

# エラー例

## object_not_found

DB がインテグレーションに共有されていないとき発生。

## validation_error

DB に必要プロパティが不足しているとき発生。

---

# まとめ

- Phase13 の Notion 同期は完成しており、全4DBの同期が可能。
- 起動時は TuningTemplates のみ自動同期される。
- プランナー側は同期後の DBを通じて RAG+テンプレ生成を行う。