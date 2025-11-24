

# 認証設計 – Agent / Admin

このプロジェクトの認証は大きく 2 系統あります。

1. **Agent API 用** – シンプルな API Key / Basic 認証
2. **Admin API 用** – Supabase Auth (JWT)

## 1. Agent API 認証

対象エンドポイント:

- `POST /agent.search`

### API Key 認証

- 環境変数でサーバー側にシークレットキーを設定
  - 例: `AGENT_API_KEY=secret-123`
- クライアントは `x-api-key` ヘッダで送信

```http
x-api-key: secret-123
```

Node 側ミドルウェア:

- ヘッダ `x-api-key` を読み取り、設定値と比較
- 不一致 or 未指定の場合は 401 を返す

### Basic 認証（オプション）

- `.env` で `BASIC_USER`, `BASIC_PASS` を設定しておけば、
  `Authorization: Basic ...` でも認証できるような実装を想定

利用例:

```bash
curl -X POST 'http://localhost:3100/agent.search' \
  -u 'user:pass' \
  -H 'Content-Type: application/json' \
  -d '{ "q": "送料について教えて" }'
```

---

## 2. Admin API 認証 – Supabase Auth

対象エンドポイント:

- `/admin/faqs` 系

### フロントエンド側の流れ

1. admin-ui (React) から Supabase プロジェクトに対して `signInWithPassword` を実行
2. 成功すると `session.access_token` (JWT) を取得
3. 以降の管理 API 呼び出しで、以下のように送信:

```http
Authorization: Bearer <access_token>
```

### バックエンド側の検証

- `.env` に以下を設定:
  - `SUPABASE_JWT_SECRET` – Supabase プロジェクトの JWT Secret
- Node 側では JWT を検証:
  - 署名の検証（HS256）
  - `exp` / `nbf` などの期限確認
  - 必要に応じて `email` や `role` を見て管理者制限をかける

### フロントエンド用 env

admin-ui 側では `.env.local` に以下を設定:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

`@supabase/supabase-js` からこれらを使ってクライアントを初期化します。

---

## 3. CORS / セキュリティ

- 本番環境では `Access-Control-Allow-Origin` を管理 UI / チャット UI のドメインに限定
- HTTP → HTTPS リダイレクト
- Cookie ベースセッションに切り替えることも可能ですが、現状は Bearer トークン方式を採用

---

## 4. 今後の拡張案

- テナントごとの管理者ロール（1 つの Supabase プロジェクト上で複数テナントを管理）
- RBAC: 「閲覧のみ」「FAQ 編集のみ」「会話フローテンプレート編集可」などの権限分離
- Audit Log: 誰がいつどの FAQ を編集したかを Postgres に記録