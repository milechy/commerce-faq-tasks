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
HERMES_MCP_API_KEY=
```

## 説明

- `NOTION_API_KEY`：commerce-faq-phase13 の Internal Integration Secret
- Notion DB ID：URL の先頭 32 文字
- ES_URL：Elasticsearch のエンドポイント
- DATABASE_URL：PostgreSQL の接続文字列
- HYBRID_TIMEOUT_MS：RAG ハイブリッド検索のタイムアウト
- PORT：起動ポート
- HERMES_MCP_API_KEY：外部 Hermes Agent VPS からの `/v1/hermes-mcp/*` MCP アクセスを認証する Bearer トークン(`src/api/hermes-mcp/hermesMcpAuth.ts`)。未設定の場合はエンドポイント全体を fail-closed で無効化し、`503 hermes_mcp_not_configured` を返す。
