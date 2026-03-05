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

---

# Agent-G: Health & SLA Config 実装計画

## 担当
Agent-G / Repo: commerce-faq-tasks

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `src/lib/health.ts` | `/health` エンドポイント: ES/PG/CE の接続確認 | P0 |
| 2 | `types/contracts.ts` + `src/types/contracts.ts` | `TenantSla` インターフェース追加 | P0 |
| 3 | `src/lib/security-policy.ts` | `skipPaths` に `/health`, `/metrics` を追加 | P0 |
| 4 | `src/index.ts` | `/health` ルートを登録 | P0 |

## セキュリティ制約

- `/health` はセンシティブ情報（接続文字列・APIキー・テナント情報）を返さない
- 認証不要だが IP フィルタ推奨（`skipPaths` で認証ミドルウェアをスキップ）
- 各コンポーネントの `ok: true/false` と応答時間（ms）のみを返す
- `console.log` でヘルスデータ（特に接続情報）を出力しない

## 実装詳細

### src/lib/health.ts
レスポンス形式（センシティブ情報なし）:
```json
{
  "status": "ok" | "degraded",
  "timestamp": "<ISO8601>",
  "components": {
    "es":  { "ok": true,  "latencyMs": 12 },
    "pg":  { "ok": true,  "latencyMs": 8  },
    "ce":  { "ok": true,  "engine": "dummy" }
  }
}
```
- ES: `client.ping()` で疎通確認
- PG: `pool.query('SELECT 1')` で疎通確認
- CE: `ceStatus().onnxLoaded` または engine != null で確認
- タイムアウト: 各コンポーネント最大 2000ms

### TenantSla インターフェース
- `completionRateMin: number`  // default 70
- `loopRateMax: number`        // default 10
- `fallbackRateMax: number`    // default 30
- `searchP95Max: number`       // default 1500
- `errorRateMax: number`       // default 1

## 完了条件

- [x] tasks/todo.md に計画を記載
- [ ] src/lib/health.ts 作成（センシティブ情報なし）
- [ ] types/contracts.ts に TenantSla 追加
- [ ] src/types/contracts.ts に TenantSla 追加
- [ ] security-policy.ts の skipPaths に /health, /metrics 追加
- [ ] src/index.ts に /health ルート登録
- [ ] pnpm typecheck → 0 errors
- [ ] pnpm test → all pass

---

# Agent-J: Admin Dashboard UI（KPI監視画面）実装計画

## 担当
Agent-J / Repo: commerce-faq-tasks / admin-ui (React + Vite)

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `admin-ui/src/components/admin/KpiCard.tsx` | KPI名・現在値・SLA閾値・達成/未達成・未達成時赤背景 | P0 |
| 2 | `admin-ui/src/components/admin/TenantSlaTable.tsx` | テナント別SLA達成率テーブル（◎/✗） | P0 |
| 3 | `admin-ui/src/pages/admin/monitoring/index.tsx` | 30秒ポーリング・KpiCard×6・ローディング表示 | P0 |
| 4 | `admin-ui/src/App.tsx` | /admin/monitoring ルート追加 | P0 |

## KPI定義（表示名・内部名対応）

| 表示名 | 内部キー | 単位 | SLA方向 |
|---|---|---|---|
| 会話完了率 | completionRate | % | ≥ completionRateMin (70%) |
| ループ検出率 | loopRate | % | ≤ loopRateMax (10%) |
| フォールバック率 | fallbackRate | % | ≤ fallbackRateMax (30%) |
| 応答速度（95%ile） | searchP95Ms | ms | ≤ searchP95Max (1500ms) |
| エラー率 | errorRate | % | ≤ errorRateMax (1%) |
| 緊急停止スイッチ | killSwitchActive | on/off | off が正常 |

## UX制約（絶対厳守）

- ❌「rajiuce_conversation_terminal_total」→ ✅「会話完了率」
- ❌「p95 latency」→ ✅「応答速度（95%ile）」
- 全ボタン min-h: 56px
- エラー時「データの取得に失敗しました 🙏 自動的に再試行します」
- ローディング時「データを取得中...」
- 未達成KPI: 赤背景で直感的に判別

## 完了条件

- [x] tasks/todo.md に計画を記載
- [ ] KpiCard.tsx 作成
- [ ] TenantSlaTable.tsx 作成
- [ ] admin/monitoring/index.tsx 作成
- [ ] App.tsx に /admin/monitoring ルート追加
- [ ] pnpm tsc --noEmit → 0 errors

---

# Agent-F: MetricsCollector + Prometheus エクスポーター 実装計画

## 担当
Agent-F / Repo: commerce-faq-tasks

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `src/lib/metrics/kpiDefinitions.ts` | Phase23の6 KPI定数定義 | P0 |
| 2 | `src/lib/metrics/metricsCollector.ts` | pinoログ→KPIカウンター更新ロジック | P0 |
| 3 | `src/lib/metrics/promExporter.ts` | prom-clientでCounter/Gauge/Histogram定義・register | P0 |
| 4 | `src/index.ts` | `/metrics` エンドポイント追加（X-Internal-Request認証） | P0 |
| 5 | `package.json` | prom-client 追加 | P0 |

## メトリクス定義

| メトリクス名 | 種別 | ラベル |
|---|---|---|
| `rajiuce_conversation_terminal_total` | Counter | reason, tenantId |
| `rajiuce_loop_detected_total` | Counter | tenantId |
| `rajiuce_avatar_requests_total` | Counter | status, tenantId |
| `rajiuce_rag_duration_ms` | Histogram | phase, tenantId |
| `rajiuce_http_errors_total` | Counter | statusCode, tenantId |
| `rajiuce_kill_switch_active` | Gauge | reason |
| `rajiuce_active_sessions` | Gauge | tenantId |

## セキュリティ制約

- `/metrics` は `X-Internal-Request: 1` ヘッダーがある場合のみ許可
- ragContent・書籍内容をメトリクスに含めない
- tenantId はラベルに使用するが PII（メールアドレス等）は含めない

## 完了条件

- [x] tasks/todo.md に計画を記載
- [x] src/lib/metrics/kpiDefinitions.ts 作成
- [x] src/lib/metrics/metricsCollector.ts 作成
- [x] src/lib/metrics/promExporter.ts 作成
- [x] src/index.ts に /metrics エンドポイント追加
- [x] pnpm typecheck → 0 errors
- [x] pnpm test → all pass

---

# Agent-I: Slack Alerting 実装計画

## 担当
Agent-I / Repo: commerce-faq-tasks

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `src/lib/alerts/slackNotifier.ts` | Slack Incoming Webhook 呼び出し | P0 |
| 2 | `src/lib/alerts/alertRules.ts` | Phase23 アラート条件の評価ロジック | P0 |
| 3 | `src/lib/alerts/alertEngine.ts` | 60秒周期評価 + cooldown 30分 | P0 |
| 4 | `src/index.ts` | AlertEngine 起動を追加（末尾） | P0 |

## アラート条件（Phase23）

| KPI | 条件 | 継続時間 | レベル |
|---|---|---|---|
| 会話完了率 | < 60% | 1時間 | CRITICAL |
| ループ検出率 | > 15% | 30分 | CRITICAL |
| アバターフォールバック率 | > 50% | 15分 | WARNING |
| 検索レイテンシ p95 | > 2000ms | 10分 | WARNING |
| エラー率 | > 3% | 5分 | CRITICAL |
| Kill Switch | 発動時即座 | 0ms | INFO |

## アーキテクチャ

```
AlertEngine (60s interval)
  └── collectRawCounters()       … prom-client から Counter/Histogram 値を取得
  └── computeSnapshot()          … delta 計算 → MetricsSnapshot
  └── ALERT_RULES[].evaluate()   … 条件評価
  └── violationDuration check    … 継続時間チェック
  └── cooldown check (30min)     … 再送防止
  └── sendSlackAlert()           … Slack Webhook POST
  └── RESOLVED 通知              … 回復時
```

## セキュリティ制約

- SLACK_WEBHOOK_URL は環境変数から取得（ハードコード禁止）
- アラートメッセージに PII・書籍内容を含めない
- Webhook 送信失敗はログのみ（アプリをクラッシュさせない）

## 完了条件

- [x] tasks/todo.md に計画を記載
- [ ] src/lib/alerts/slackNotifier.ts 作成
- [ ] src/lib/alerts/alertRules.ts 作成
- [ ] src/lib/alerts/alertEngine.ts 作成
- [ ] src/index.ts に AlertEngine 起動を追加
- [ ] pnpm typecheck → 0 errors
- [ ] pnpm test → all pass

---

# Phase25: Lemonslice Avatar強化 実装計画

## 担当
RAJIUCE統括アーキテクト / agent_id: `agent_aee377cb0fec68ea`

## 実装ファイル一覧

| # | ファイル | 内容 | 優先度 |
|---|---------|------|--------|
| 1 | `src/lib/avatar/avatarStorage.ts` | アバター画像の AES-256-GCM 暗号化保存/復号 | P0 |
| 2 | `src/lib/avatar/lemonsliceAvatarApi.ts` | Lemonslice API へのアバター登録（LiveKit設定含む） | P0 |
| 3 | `src/lib/avatar/voiceSettings.ts` | 音声設定（男性/女性/ニュートラル、話速、ピッチ） | P0 |
| 4 | `admin-ui/src/components/admin/AvatarUpload.tsx` | アバター画像アップロードUI（親切文言） | P0 |
| 5 | `admin-ui/src/components/admin/VoiceSettings.tsx` | 音声設定UI（専門用語なし） | P0 |

## 制約（絶対厳守）

- Phase10 の LiveKit 設定を流用する（endpoint/token の扱いを統一）
- tenantId は JWT 由来のみ（request body から受け取らない）
- アバター画像は保存前に AES-256 で暗号化（認証タグ付き）
- 管理UIは専門用語を使わない
- ボタンは `min-height: 56px` 以上
- タッチターゲットは `44px` 以上

## 実装手順

1. `avatarStorage.ts`
   - 32byte キー（base64/hex/utf8）を環境変数から読み込み
   - `AES-256-GCM` で `iv + authTag + ciphertext` を保存形式として管理
   - tenantId / mimeType / hash を含むメタ情報を返却
2. `lemonsliceAvatarApi.ts`
   - JWT 由来 tenantId を受け取る型で API 呼び出し
   - LiveKit（Phase10流用）設定を payload に含めて登録
   - 失敗時は内部情報を漏らさない安全なエラーメッセージ
3. `voiceSettings.ts`
   - 音声タイプ、話速、ピッチのバリデーション
   - デフォルト値と正規化処理を提供
4. `AvatarUpload.tsx` / `VoiceSettings.tsx`
   - 390px 幅でも押しやすい配置
   - 成功/失敗の親切なフィードバック
   - JWT を使って API 呼び出し（tenantId を body に含めない）

## 完了条件

- [x] tasks/todo.md に計画を記載
- [x] `src/lib/avatar/avatarStorage.ts` 実装
- [x] `src/lib/avatar/lemonsliceAvatarApi.ts` 実装
- [x] `src/lib/avatar/voiceSettings.ts` 実装
- [x] `admin-ui/src/components/admin/AvatarUpload.tsx` 実装
- [x] `admin-ui/src/components/admin/VoiceSettings.tsx` 実装
- [x] `pnpm verify` が成功
