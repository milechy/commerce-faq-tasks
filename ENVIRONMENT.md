# ENVIRONMENT.md

Phase13 のバックエンドに必要な `.env` パラメータ一覧。

```
NOTION_API_KEY=
NOTION_DB_FAQ_ID=
NOTION_DB_PRODUCTS_ID=
NOTION_DB_LP_POINTS_ID=
NOTION_DB_TUNING_TEMPLATES_ID=
NOTION_DB_CLARIFY_LOG_ID=

ES_URL=
DATABASE_URL=
HYBRID_TIMEOUT_MS=
PORT=3100
```

## 説明

- `NOTION_API_KEY`：commerce-faq-phase13 の Internal Integration Secret
- Notion DB ID：URL の先頭 32 文字
- ES_URL：Elasticsearch のエンドポイント
- DATABASE_URL：PostgreSQL の接続文字列
- HYBRID_TIMEOUT_MS：RAG ハイブリッド検索のタイムアウト
- PORT：起動ポート
