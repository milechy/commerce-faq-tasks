

# Admin API – FAQ 管理

管理 UI や将来の運用ツールから利用する、FAQ 管理用の API 群です。

- ベースパス: `/admin`
- 認証: `Authorization: Bearer <Supabase JWT>`
- マルチテナント: クエリパラメータ `tenantId` で対象テナントを指定

## 認証

### Supabase Auth

- 管理者は admin-ui (React) から Supabase Auth にログイン
- Supabase が返す `access_token` (JWT) を、バックエンドに渡す
- バックエンドでは `SUPABASE_JWT_SECRET` を使って JWT を検証し、
  有効な管理者のみが `/admin/*` にアクセスできる

HTTP ヘッダ例:

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## リソース: FAQ

永続化は PostgreSQL の `faq_docs` テーブルがソース・オブ・トゥルースです。

### 一覧取得 – `GET /admin/faqs`

**クエリパラメータ**

- `tenantId` (string, required): テナント ID（例: `demo`）
- `limit` (number, optional, default 50)
- `offset` (number, optional, default 0)

**レスポンス例**

```json
{
  "items": [
    {
      "id": 3,
      "tenant_id": "demo",
      "question": "返品・交換時の送料は？",
      "answer": "返品・交換時の送料はお客様負担となります。初期不良の場合は当店負担です。",
      "category": "shipping",
      "es_doc_id": "CyQSpZoBKf6L66OCzmvW",
      "tags": [],
      "is_published": true,
      "created_at": "2025-11-22T05:49:09.575Z",
      "updated_at": "2025-11-22T05:49:09.575Z"
    },
    ...
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "count": 3
  }
}
```

### 単体取得 – `GET /admin/faqs/:id`

**パスパラメータ**

- `id` (number): FAQ ID

**クエリパラメータ**

- `tenantId` (string, required)

**レスポンス例**

```json
{
  "id": 1,
  "tenant_id": "demo",
  "question": "送料について教えて",
  "answer": "送料は全国一律500円ですが、5,000円以上で送料無料になります。",
  "category": "shipping",
  "es_doc_id": "CSQSpZoBKf6L66OCmmve",
  "tags": [],
  "is_published": true,
  "created_at": "2025-11-22T05:49:09.575Z",
  "updated_at": "2025-11-22T08:13:31.755Z"
}
```

### 更新 – `PUT /admin/faqs/:id`

FAQ の内容を更新し、**ES ドキュメント** と **pgvector embedding** を自動で同期します。

**パスパラメータ**

- `id` (number): FAQ ID

**クエリパラメータ**

- `tenantId` (string, required)

**リクエストボディ**

```json
{
  "question": "送料について教えて",        // optional
  "answer": "送料は全国一律500円ですが...", // optional
  "category": "shipping",                // optional
  "tags": ["送料", "配送料"] ,           // optional
  "isPublished": true                      // optional
}
```

- 設定されているフィールドのみ更新
- `question` / `answer` / `category` / `tags` / `is_published` は DB に反映

**サーバー側での副作用**

1. PostgreSQL `faq_docs` を更新
2. Elasticsearch `faqs` インデックスを `es_doc_id` 経由で更新
3. Groq Embedding API に `question + answer` を渡してベクトルを生成
4. `faq_embeddings` に対し、`(tenant_id, faq_id)` 単位で upsert
   - `metadata = { "source": "faq", "faq_id": "<id>" }`

**レスポンス例**

```json
{
  "id": 1,
  "tenant_id": "demo",
  "question": "送料について教えて",
  "answer": "送料は全国一律500円ですが、5,000円以上で送料無料になります。",
  "category": "shipping",
  "es_doc_id": "CSQSpZoBKf6L66OCmmve",
  "tags": [],
  "is_published": true,
  "created_at": "2025-11-22T05:49:09.575Z",
  "updated_at": "2025-11-22T08:13:31.755Z"
}
```

### （将来）作成 / 削除

- `POST /admin/faqs`
- `DELETE /admin/faqs/:id`

は今後の拡張で実装予定です。現時点では **既存 FAQ の更新** を主たるユースケースとしています。

## エラーレスポンス

典型的なエラー形式:

```json
{
  "error": "Failed to update FAQ",
  "detail": "error: column \"is_published\" does not exist"
}
```

フロントエンドでは `detail` をデバッグ表示に活用しつつ、ユーザーにはもう少しフレンドリーなメッセージを見せる想定です。