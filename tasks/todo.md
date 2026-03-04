# Agent-B: RAG + Pinecone + Groq パイプライン 実装計画

## 担当
Agent-B / Repo: commerce-faq-tasks

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `lib/pinecone.ts` | Pineconeベクター検索・tenantIdフィルタ強制注入 | P0 |
| 2 | `lib/groq.ts` | モデルルーティング: 8B default / 70B for complexity > 0.7 | P0 |
| 3 | `lib/embeddings.ts` | OpenAI text-embedding-3-small | P0 |
| 4 | `convex/knowledge.ts` | 書籍PDF管理・AES-256暗号化・書籍内容漏洩防止 | P0 |

## セキュリティ制約（CLAUDE.md Anti-Slop）

- `ragExcerpt.slice(0, 200)` 必須
- `console.log(ragChunk.text)` 禁止
- 書籍内容をLLMの学習データとして送らない
- `tenantId` フィルタを全検索クエリに強制注入
- AES-256-GCM で書籍テキスト暗号化・復号はRAG取得時のみ

## コスト制約

- 8B モデル (llama-3.1-8b-instant) をデフォルト使用
- 70B (llama-3.3-70b-versatile) は complexity > 0.7 のみ
- 月 $27-48 以内

## 完了条件

- [ ] pnpm typecheck → 0 errors
- [ ] pnpm lint → 0 warnings
- [ ] RAG抜粋が200文字以内になっていること
- [ ] tenantIdフィルタが全クエリに注入されること
- [ ] 書籍テキストがAES-256-GCMで暗号化されること
- [ ] console.logにragChunk.textが出力されないこと

---

# Agent-C: チャットウィジェット（モバイルファースト）実装計画

## 担当
Agent-C / Repo: commerce-faq-tasks

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `admin-ui/src/components/widget/MessageList.tsx` | メッセージ一覧・auto-scroll・role別スタイル | P0 |
| 2 | `admin-ui/src/components/widget/ChatInput.tsx` | 入力フォーム・送信ボタン・44pxタッチターゲット | P0 |
| 3 | `admin-ui/src/components/widget/ChatWidget.tsx` | メインウィジェット・浮きボタン+パネル・postMessage通信 | P0 |
| 4 | `public/widget.js` | 1行埋め込み・Shadow DOM・origin検証・no-innerHTML | P0 |

## アーキテクチャ

```
<script src="/widget.js" data-tenant="TENANT_ID" async></script>
  └── public/widget.js（Vanilla JS）
        ├── Shadow DOM（CSS isolation）
        ├── tenantId = script.getAttribute('data-tenant')
        ├── API呼び出し: POST /api/chat (X-Tenant-ID ヘッダ)
        └── postMessage: window ↔ ホストサイト（origin 検証）

admin-ui/src/components/widget/（React・管理画面内プレビュー用）
  ├── ChatWidget.tsx  … 全体コンテナ・state管理
  ├── MessageList.tsx … メッセージ一覧・auto-scroll
  └── ChatInput.tsx   … 入力フォーム・送信ボタン
```

## モバイル制約（絶対厳守）

- タッチターゲット全て `minHeight: 44px; minWidth: 44px`
- フォントサイズ全て `fontSize: 16px` 以上
- 390px viewport でレスポンシブ対応
- `prefers-reduced-motion` でアニメーション無効化

## セキュリティ制約

- `innerHTML` 禁止 → `textContent` / `createElement` を使用
- `tenantId` は `data-tenant` 属性から取得（bodyから禁止）
  - サーバーへは `X-Tenant-ID` ヘッダで送信し、サーバー側で検証
- `postMessage` 受信時は `event.origin` を検証してから処理
- `ragContent` をコンソールログしない
- `console.log(ragContent)` 禁止

## API通信フロー

```
widget.js
  → POST /api/chat
      Headers: { X-Tenant-ID: tenantId, Content-Type: application/json }
      Body:    { message, conversationId, history }
  ← ApiResponse<ChatMessage>
      { data: { id, role, content, timestamp, tenantId }, requestId }
```

## 完了条件

- [ ] pnpm typecheck → 0 errors (admin-ui)
- [ ] タッチターゲット全て 44px 以上
- [ ] フォントサイズ 16px 以上
- [ ] `innerHTML` 不使用確認
- [ ] `postMessage` origin 検証あり
- [ ] `console.log(ragContent)` なし

---

# Agent-E: APIセキュリティ層 実装計画

## 担当
Agent-E-Security / Repo: commerce-faq-tasks

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `src/lib/request-id.ts` | requestId 生成・Expressミドルウェア / `req.requestId` 付与 / `X-Request-ID` ヘッダ往復 | P0 |
| 2 | `src/lib/headers.ts` | セキュリティヘッダ全種 Express ミドルウェア | P0 |
| 3 | `src/lib/rate-limit.ts` | テナント別インメモリ sliding-window 100req/min | P0 |
| 4 | `src/api/chat/route.ts` | `/api/chat` エンドポイント + Zod スキーマ検証 | P0 |

## セキュリティ制約（CLAUDE.md Anti-Slop）

- `tenantId` は JWT/ミドルウェア由来のみ（`req.body` から取得禁止）
- `ragExcerpt.slice(0, 200)` 必須
- `console.log(ragContent)` 禁止
- APIキー・書籍内容をログ出力しない
- 全ログに `requestId` を含める

## 実装詳細

### src/lib/request-id.ts
- `crypto.randomUUID()` で requestId 生成（Node 14.17+ ビルトイン）
- `X-Request-ID` ヘッダが来ていれば使いまわす（同一リクエスト追跡）
- `req.requestId` に設定し、後続ミドルウェア・ハンドラから参照可能に
- レスポンスに `X-Request-ID` を付与

### src/lib/headers.ts
適用するヘッダ:
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy: default-src 'none'`（API サーバのため）
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Cache-Control: no-store` (API レスポンスキャッシュ禁止)
- `X-Powered-By` 除去（express app レベルで実施済み）

### src/lib/rate-limit.ts
- テナント別 sliding window (1分間)
- デフォルト上限: 100 req/min / tenant (`TenantConfig.security.rateLimit` で上書き可)
- 429 レスポンス: `{ error: "rate_limit_exceeded", requestId, tenantId }`
- ヘッダ: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- メモリリーク対策: 古いウィンドウを自動削除

### src/api/chat/route.ts
Zod スキーマ:
```typescript
ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
  sessionId: z.string().optional(),
  options: z.object({
    language: z.enum(['ja', 'en']).default('ja'),
    piiMode: z.boolean().default(false),
  }).optional(),
})
```
- `tenantId` は `req.tenantId` から取得（bodyから禁止）
- requestId は `req.requestId` を使用
- レスポンス型: `ApiResponse<ChatMessage>`
- バリデーション失敗 → 400 + 親切なエラーメッセージ

## 完了条件

- [ ] pnpm typecheck → 0 errors
- [ ] pnpm lint → 0 warnings
- [ ] Snyk コードスキャン → P0/P1 なし
- [ ] 全エンドポイントに Zod スキーマ適用
- [ ] ログに APIキー・書籍内容が出力されないこと確認

---

# Agent-D: パートナー向け管理画面 実装計画

## 担当
Agent-D / Repo: commerce-faq-tasks / admin-ui (React + Vite)

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `admin-ui/src/components/admin/FileUpload.tsx` | ドラッグ&ドロップ、PDF/50MB検証、成功フィードバック | P0 |
| 2 | `admin-ui/src/components/admin/TuningPanel.tsx` | チューニング設定パネル（テンプレ・モデル設定） | P0 |
| 3 | `admin-ui/src/pages/admin/index.tsx` | 管理ダッシュボード（FAQ数・書籍数・ステータス集計） | P0 |
| 4 | `admin-ui/src/pages/admin/knowledge/index.tsx` | 書籍PDF管理画面（一覧・アップロード・削除） | P0 |
| 5 | `admin-ui/src/App.tsx` | /admin・/admin/knowledge ルート追加 | P0 |

## UX 制約（絶対厳守）

- 専門用語禁止（例: ❌「ベクター埋め込み処理中」→ ✅「AIが内容を確認中... 約1分かかります」）
- 全エラーは親切なメッセージ（❌ 500 Internal Server Error → ✅「少し問題が起きました。もう一度試してみてください 🙏」）
- ボタン高さ min-height: 56px
- 操作後は必ず成功フィードバック（チェックマーク表示）
- ドラッグ&ドロップ必須
- フォントサイズ ≥16px
- タッチターゲット ≥44px

## セキュリティ制約

- PDFのみ受け付け（MIMEタイプ: application/pdf）
- ファイルサイズ上限: 50MB（= 50 * 1024 * 1024 bytes）
- アップロード後はサーバーでAES-256暗号化（Agent B実装済み）
- tenantId は JWT/ミドルウェア由来のみ（bodyから取得禁止）

## 完了条件

- [ ] pnpm typecheck → 0 errors（admin-ui）
- [ ] PDF以外のファイルを弾くこと
- [ ] 50MBを超えるファイルを弾くこと
- [ ] ドラッグ&ドロップが390px viewportで動作すること
- [ ] 全操作後に成功フィードバックが表示されること
- [ ] エラー時に親切なメッセージが表示されること
