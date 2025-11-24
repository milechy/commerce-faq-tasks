# Phase6: n8n 連携 / Webhook / Auth 全体設計

## 1. ゴールと非ゴール

### ゴール

- AI FAQ SaaS (`commerce-faq-tasks`) を **外部オーケストレーター（n8n 等）から安全に呼び出せる** ようにする。
- `/agent.dialog` / `/agent.search` に **認証レイヤー** を追加する。
- Groq 429 / 500 などの **fallback / エラー / レイテンシ情報を Webhook で n8n 側に通知** できるようにする。
- n8n 側では、受け取ったイベントを元に **Slack 通知 / Notion 登録 / チケット発行などのオートメーション** を構成できる状態にする。
- 既存の API 入出力仕様は維持しつつ、**メタ情報を拡張していくための共通フォーマット** を定義する。

### 非ゴール（Phase6 時点）

- サーバ側で **p95 を長期集計 / 永続化** すること（p95 集計は n8n 等の外部に任せる）。
- CrewAI などのマルチエージェント基盤を本格導入すること
  - Phase6 では、CrewAI を入れても破綻しないような **拡張ポイント** を整理するところまで。

---

## 2. 現状の HTTP API 概要（Phase5 / Phase6-minimal）

### `/agent.dialog` (POST)

- 実装: `src/agent/http/agentDialogRoute.ts`
- index 登録: `src/index.ts`

```ts
app.post(
  '/agent.dialog',
  auth,
  parseJSON,
  createAgentDialogHandler(logger, { webhookNotifier }),
)

	•	リクエスト（簡略）

const DialogMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
})

const DialogOptionsSchema = z.object({
  topK: z.number().int().min(1).max(20).optional(),
  language: z.enum(["ja", "en", "auto"]).optional(),
  useLlmPlanner: z.boolean().optional(),
  useMultiStepPlanner: z.boolean().optional(),
  mode: z.enum(["local", "crew"]).optional(),
  debug: z.boolean().optional(),
})

const AgentDialogSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
  history: z.array(DialogMessageSchema).optional(),
  options: DialogOptionsSchema.optional(),
})

	•	処理フロー（ざっくり）
	1.	DIALOG_ORCHESTRATOR_MODE が langgraph（デフォルト）なら runDialogGraph を呼ぶ。
	2.	LangGraph / Groq 側でエラー、特に GroqRateLimitError が起きた場合は ローカル runDialogTurn にフォールバック。
	3.	フォールバック時は groq429Fallback フラグや langgraphError を meta に詰め直す。
	4.	最後に logger.info(... "agent.dialog final summary") で構造化ログを出している。
	•	LangGraph 経由の成功レスポンス（抜粋）

res.json({
  sessionId: data.sessionId,
  answer: output.text,
  steps: plan?.steps ?? [],
  final: !(plan?.needsClarification ?? false),
  needsClarification: plan?.needsClarification ?? false,
  clarifyingQuestions: plan?.clarifyingQuestions ?? [],
  meta: {
    route: output.route,                   // '20b' / '120b' など
    plannerReasons: output.plannerReasons,
    orchestratorMode: "langgraph",
    safetyTag: output.safetyTag,
    requiresSafeMode: output.requiresSafeMode,
    ragStats: output.ragStats,            // { search_ms, rerank_ms, total_ms, rerank_engine }
  },
})

	•	フォールバック時の meta 追加（ローカル dialogAgent 側）

const orchestratorMode = groq429Fallback
  ? "fallback-local-429"
  : meta.orchestratorMode ?? "local"

(result as any).meta = {
  ...meta,
  orchestratorMode,
  langgraphError: safeMessage,        // LangGraph 側のエラー要約
}

	•	最終サマリログ

logger.info(
  {
    sessionId: data.sessionId ?? "unknown-session",
    locale: data.options?.language ?? "ja",
    orchestratorMode: finalMeta.orchestratorMode ?? (useLangGraph ? "langgraph" : "local"),
    route: finalMeta.route ?? "20b",
    groq429Fallback,
    hasLanggraphError: !!langgraphError,
    groqBackoffRemainingMs,
    durationMs: Date.now() - startedAt,
  },
  "agent.dialog final summary",
)

/agent.search (POST)
	•	実装: src/agent/http/agentSearchRoute.ts
	•	schema: q, topK, debug, useLlmPlanner
	•	ルーティング: LangGraph Orchestrator 内の runSearchAgent を利用。
	•	Phase6 で 認証対象 + Webhook 対象 に含める（/agent.dialog と同じ auth レイヤー）。
	•	Webhook では agent.search.completed / agent.search.error イベントを送信する。

/search.v1, /ce/status, /ce/warmup, /health, /debug/env
	•	src/index.ts に実装。
	•	RAG Hybrid (src/search/hybrid.ts) ＋ Cross-Encoder rerank のテスト用 / ベンチ用エンドポイント。
	•	原則として 外部公開は想定せず、社内 / 開発用途。
	•	Phase6 の Auth 設計では、以下方針とする:
	•	/health: 認証なしでも OK（k8s Liveness/Readiness 用）。
	•	/debug/env: デフォルトは 本番では閉じる想定（NODE_ENV=production では 404 or 認証必須にするなど）。
	•	/search.v1, /ce/*: 原則 Auth 対象。ただし CLI ベンチから叩きやすいように env で OFF にできるようにする。

⸻

8. Phase6 時点で実装した n8n Workflow メモ

本ドキュメント 4–5 章の設計をもとに、Phase6 では実際に n8n Cloud 上で以下のワークフローを構成した。ここでは「実装したもの」を再現できるように、最低限の設定をテキストで残しておく。

### 8.1 共通: Agent Events Webhook

- n8n 側のトリガー: **Webhook Trigger ノード**
- URL 例:
  - 本番用: `https://<workspace>.n8n.cloud/webhook/agent-events`
  - テスト用: `https://<workspace>.n8n.cloud/webhook-test/agent-events`
- HTTP Method: `POST`
- Payload 形式（n8n の Webhook ノード OUTPUT）:

  ```jsonc
  {
    "headers": { ... },
    "params": {},
    "query": {},
    "body": { /* WebhookNotifier から送った AgentWebhookEvent */ },
    "webhookUrl": "https://.../webhook/agent-events",
    "executionMode": "regular" | "test"
  }
  ```

- curl テスト例（テスト URL 使用）:

  ```bash
  curl -X POST "https://<workspace>.n8n.cloud/webhook-test/agent-events" \
    -H "Content-Type: application/json" \
    -d '{
      "body": {
        "type": "agent.dialog.error",
        "timestamp": "2025-11-20T11:05:00.000Z",
        "endpoint": "/agent.dialog",
        "latencyMs": 2500,
        "tenantId": "default",
        "meta": {
          "route": "20b",
          "orchestratorMode": "langgraph",
          "groq429Fallback": false,
          "hasLanggraphError": false
        },
        "error": {
          "name": "GroqRateLimitError",
          "message": "429 from Groq"
        }
      }
    }'
  ```

> 補足: テスト用 Webhook URL に対しては、上記のように一段ラップした `{ "body": { ... } }` 形式で送ったため、n8n 側では `body.body.*` という 2 段ネストになっている。SaaS 本番から直接 Webhook を叩く場合は、ラップなしの `{ ... }` を送る想定（この場合は n8n 側で `body.*` を参照する）。

---

### 8.2 Error / Fallback → Slack 通知

目的: `agent.dialog.error` / `agent.dialog.fallback` などの重大イベントを Slack チャンネルに即時通知する。

ワークフロー構成（概念図）:

```text
Agent Events Webhook
  └─ If ErrorOrFallback (True)
        └─ HTTP Request (Slack 通知)
      (False)
        └─ 何もしない
```

#### 8.2.1 If ErrorOrFallback ノード

- 条件: `All` / `AND`
- ルール例（簡易版）:
  - `{{$json.body.type}}` が `agent.dialog.error` と等しい
  - **OR** `{{$json.body.type}}` が `agent.dialog.fallback` と等しい

※ テスト Webhook の場合は `{{$json.body.body.type}}` を使う。

#### 8.2.2 HTTP Request (Slack) ノード

- HTTP Method: `POST`
- URL: `https://slack.com/api/chat.postMessage`
- Authentication: Header Auth（Slack Bot Token）
- Send Body: `true`
- Content Type: `JSON`
- Body Parameters:
  - `channel`: 例 `commerce-faq-monitoring`
  - `text`: Expression

`text` の Expression（テスト Webhook の 2 段ネスト版）:

```js
{{
  '[ALERT][' + $json.body.body.type + ']\n\n' +
  'endpoint: ' + $json.body.body.endpoint + '\n' +
  'latency: ' + $json.body.body.latencyMs + ' ms\n' +
  'route: ' + ($json.body.body.meta?.route ?? 'n/a') + '\n' +
  'orchestrator: ' + ($json.body.body.meta?.orchestratorMode ?? 'n/a') + '\n' +
  'groq429Fallback: ' + String($json.body.body.meta?.groq429Fallback) + '\n' +
  'hasLanggraphError: ' + String($json.body.body.meta?.hasLanggraphError) + '\n\n' +
  'error: ' +
    (($json.body.body.error?.name) || 'n/a') +
    ' - ' +
    (($json.body.body.error?.message) || 'n/a')
}}
```

本番 Webhook（ラップなし）では、同じ式の `body.body` を `body` に置き換えればよい:

- 例: `$json.body.body.type` → `$json.body.type`

---

### 8.3 Clarify Needed → Notion Clarify Log + Slack 通知

目的: `needsClarification = true` の対話（planner が Clarify を返したケース）を

- Notion データベース **Clarify Log** に蓄積
- 同時に Slack にも通知して、運用初期に異常や傾向を把握しやすくする

ワークフロー構成（概念図）:

```text
Agent Events Webhook
  ├─ If ErrorOrFallback (True) → Slack ALERT
  └─ If ClarifyNeeded (True)
        ├─ Notion (Create Clarify Log Item)
        └─ HTTP Request (Slack CLARIFY 通知)
```

#### 8.3.1 If ClarifyNeeded ノード

- 役割: Clarify 系イベントだけを後段に流す
- 条件例:
  - `{{$json.body.body.type}}` が `agent.dialog.clarify_needed` と等しい

本番 Webhook では `{{$json.body.type}} == 'agent.dialog.clarify_needed'` にする。

#### 8.3.2 Notion: Create Clarify Log Item

- ノードタイプ: **Notion**
- Operation: `Create`
- Resource: `Page`
- Database: `Clarify Log`（あらかじめ作成しておく）
- Credential: `Notion API (Commerce FAQ)` など、専用 integration を利用

Clarify Log データベースの推奨フィールド:

- `title` (Title)
  - 値: Expression 例

    ```text
    Clarify: {{$json.body.body.meta?.sessionId ?? 'unknown-session'}}
    ```

- `status` (Status)
  - オプション: `未確認` / `対応中` / `完了`
  - デフォルト値: `未確認`

- `sessionId` (Text)
  - 値: `{{$json.body.body.meta?.sessionId ?? 'n/a'}}`

- `endpoint` (Text)
  - 値: `{{$json.body.body.endpoint}}`

- `route` (Text)
  - 値: `{{$json.body.body.meta?.route ?? 'n/a'}}`

- `clarifyingQuestions` (Text または Long text)
  - 値: `{{$json.body.body.clarifyingQuestions ?? 'n/a'}}`

- `timestamp` (Date)
  - 値: `{{$json.body.body.timestamp}}`

> 備考: 上記の `body.body.*` はテスト用 Webhook に合わせた指定。本番 Webhook を直接受けるワークフローでは `body.*` に読み替える。

#### 8.3.3 Slack: Clarify 通知ノード

- ノードタイプ: **HTTP Request**（Slack Bot Token を流用）
- URL: `https://slack.com/api/chat.postMessage`
- Body Parameters:
  - `channel`: 例 `commerce-faq-monitoring`
  - `text`: Expression

`text` の Expression（テスト Webhook 版）:

```js
{{
  '[CLARIFY][' + $json.body.body.type + ']\n' +
  'endpoint: ' + $json.body.body.endpoint + '\n' +
  'route: ' + ($json.body.body.meta?.route ?? 'n/a') + '\n' +
  'sessionId: ' + ($json.body.body.meta?.sessionId ?? 'n/a') + '\n' +
  'question:\n' +
  ($json.body.body.clarifyingQuestions ?? 'n/a')
}}
```

Slack 側の出力イメージ:

```text
[CLARIFY][agent.dialog.clarify_needed]
endpoint: /agent.dialog
route: 20b
sessionId: test-session-clarify-1
question:
これはテストClarifyです。
```

---

### 8.4 Slow Request (latencyMs > 2000ms) → Slack 通知

目的: `/agent.dialog` / `/agent.search` などのリクエストで **レイテンシが 2000ms を超えたものだけ** を別チャンネルに通知し、p95 監視のたたき台にする。

ワークフロー構成（概念図）:

```text
Agent Events Webhook
  └─ If SlowRequest (True)
        └─ HTTP Request (Slack: commerce-faq-slow-requests)
      (False)
        └─ 何もしない
```

#### 8.4.1 If SlowRequest ノード

- 条件: `Single` / `All` (AND)
- ルール（テスト Webhook の 2 段ネスト版）:
  - 左辺: Expression `{{$json.body.body.latencyMs}}`
  - 型: `Number`
  - Operation: `is greater than`
  - 右辺: `2000`

本番 Webhook（`{ ... }` をそのまま送る想定）では、同じ式の `body.body` を `body` に読み替える:

- 例: `$json.body.body.latencyMs` → `$json.body.latencyMs`

#### 8.4.2 Slack: SlowRequest 通知ノード

- ノードタイプ: **HTTP Request**（Slack Bot Token を使った `chat.postMessage`）
- URL: `https://slack.com/api/chat.postMessage`
- Body Parameters:
  - `channel`: 例 `commerce-faq-slow-requests`
  - `text`: Expression

`text` の Expression（テスト Webhook 版）:

```js
{{
  '[SLOW REQUEST][' + ($json.body.body.endpoint ?? 'n/a') + ']\n' +
  'type: ' + $json.body.body.type + '\n' +
  'endpoint: ' + $json.body.body.endpoint + '\n' +
  'latency: ' + $json.body.body.latencyMs + ' ms\n' +
  'route: ' + ($json.body.body.meta?.route ?? 'n/a') + '\n' +
  'sessionId: ' + ($json.body.body.meta?.sessionId ?? 'n/a')
}}
```

本番 Webhook では上記の `body.body` を `body` に変更すればよい。

Slack 側の出力イメージ:

```text
[SLOW REQUEST][/agent.search]
type: agent.search.completed
endpoint: /agent.search
latency: 2500 ms
route: 20b
sessionId: n/a
```

---

### 8.5 SearchError → Slack ALERT (/agent.search)

目的: `/agent.search` でエラーが発生した場合（`agent.search.error`）を、対話エラーと同じアラートチャンネルに流す。

ワークフロー構成（概念図）:

```text
Agent Events Webhook
  ├─ If ErrorOrFallback (agent.dialog.*) → Slack ALERT
  ├─ If SearchError (agent.search.error) → Slack ALERT
  └─ If ClarifyNeeded → Notion + Slack
```

#### 8.5.1 If SearchError ノード

- 条件: `Single` / `All` (AND)
- ルール（テスト Webhook の 2 段ネスト版）:
  - `{{$json.body.body.type}}` が `agent.search.error` と等しい

本番 Webhook では `{{$json.body.type}} == 'agent.search.error'` に読み替える。

#### 8.5.2 HTTP Request (Slack ALERT) ノード

- 既存の ErrorOrFallback 用 Slack ノード（`commerce-faq-monitoring` チャンネル）と同じ設定を再利用する。
- Body Parameters:
  - `channel`: 例 `commerce-faq-monitoring`
  - `text`: Expression

`text` の Expression（テスト Webhook 版）:

```js
{{
  '[ALERT][' + $json.body.body.endpoint + '][' + $json.body.body.type + ']\n\n' +
  'endpoint: ' + $json.body.body.endpoint + '\n' +
  'latency: ' + $json.body.body.latencyMs + ' ms\n' +
  'route: ' + ($json.body.body.meta?.route ?? 'n/a') + '\n' +
  'error: ' +
    (($json.body.body.error?.name) || 'n/a') +
    ' - ' +
    (($json.body.body.error?.message) || 'n/a')
}}
```

本番 Webhook では同様に `body.body` → `body` に変更する。

Slack 側の出力イメージ:

```text
[ALERT][/agent.search][agent.search.error]
endpoint: /agent.search
latency: 1234 ms
route: 20b
error: SearchAgentError - something went wrong in search
```

---

### 8.6 運用メモ

- Phase6 では、監視と Clarify ログ蓄積の最小セットとして以下を n8n で構成した:
  - Error / Fallback (`agent.dialog.error` / `agent.dialog.fallback` / `agent.search.error`) → Slack ALERT
  - Clarify Needed (`agent.dialog.clarify_needed`) → Slack + Notion Clarify Log
  - Slow Request (`latencyMs > 2000ms`) → 専用チャンネル `commerce-faq-slow-requests` に通知
- 将来的には、ここで取っているイベントを元に n8n 側で p50/p95 集計やチケット自動起票などに拡張できる。

3. 認証レイヤー設計

3.1 方針
	•	認証方式は API Key と Basic 認証の両方をサポート し、どちらか通れば OK（OR 条件）。
	•	既存クライアントとの互換性のため、環境変数が設定されていない場合は認証を無効化（開発モード） とする。
	•	認証失敗時は 401 で JSON を返すが、既存の正常レスポンス / エラー JSON スキーマは変更しない。

3.2 対象エンドポイント
	•	認証 必須（本番想定）:
	•	POST /agent.dialog
	•	POST /agent.search
	•	POST /search.v1
	•	POST /ce/warmup
	•	認証 推奨:
	•	GET /ce/status
	•	GET /debug/env（NODE_ENV=production では必須 or 無効化）
	•	認証 不要:
	•	GET /health

※ 実装時に NODE_ENV / 専用 env（例: PUBLIC_ENDPOINTS=/health,/metrics など）で微調整できるようにする。

3.3 環境変数

# API Key 認証
AGENT_API_KEY=your-secret-key

# Basic 認証
AGENT_BASIC_USER=your-user
AGENT_BASIC_PASSWORD=your-password

	•	いずれも未設定 (AGENT_API_KEY かつ AGENT_BASIC_USER/AGENT_BASIC_PASSWORD が空) の場合は auth 無効 (開発モード)。
	•	本番環境では少なくともどちらかは設定する運用。

3.4 実装方針
	•	新規ファイル: src/agent/http/middleware/auth.ts

export function createAuthMiddleware(logger: pino.Logger) {
  const apiKey = process.env.AGENT_API_KEY
  const basicUser = process.env.AGENT_BASIC_USER
  const basicPass = process.env.AGENT_BASIC_PASSWORD

  const authDisabled = !apiKey && !basicUser && !basicPass

  return function auth(req: Request, res: Response, next: NextFunction) {
    if (authDisabled) return next()

    // 1. API Key (X-API-Key)
    const headerKey = req.header('x-api-key')
    if (apiKey && headerKey && headerKey === apiKey) {
      return next()
    }

    // 2. Basic Auth
    const authHeader = req.header('authorization') || ''
    if (basicUser && basicPass && authHeader.startsWith('Basic ')) {
      // base64 decode, user:pass 比較
      ...
      if (ok) return next()
    }

    logger.warn({ path: req.path }, 'unauthorized access')
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid or missing credentials',
    })
  }
}

	•	適用箇所（src/index.ts）

const auth = createAuthMiddleware(logger)
const webhookNotifier = new WebhookNotifier(logger)

app.post(
  '/agent.search',
  auth,
  parseJSON,
  createAgentSearchHandler(logger, { webhookNotifier }),
)
app.post(
  '/agent.dialog',
  auth,
  parseJSON,
  createAgentDialogHandler(logger, { webhookNotifier }),
)
// /search.v1, /ce/* も原則 auth 対象（Phase6 実装済み）

	•	.env.example に追記:

AGENT_API_KEY=
AGENT_BASIC_USER=
AGENT_BASIC_PASSWORD=


⸻

4. Webhook 通知設計（n8n 連携）

4.1 方針
	•	アプリ側から「イベント Webhook」を HTTP POST で送信する。
	•	n8n 側では Webhook Trigger ノードで受け取り、後段で Slack / Notion / チケット発行などにつなげる。
	•	Webhook 送信失敗は 本体のレスポンスに影響を与えない（ログだけ残し、処理は継続）。

4.2 環境変数

# n8n 側の Webhook URL (例: https://n8n.example.com/webhook/agent-events)
N8N_WEBHOOK_URL=

# 任意の認証ヘッダをそのまま付与する（例: "x-api-key: xxx"）
N8N_WEBHOOK_AUTH_HEADER=

# タイムアウト (ms)。未設定なら 2000ms 程度をデフォルト。
N8N_WEBHOOK_TIMEOUT_MS=2000

	•	N8N_WEBHOOK_URL が空の場合は Webhook を 送信しない (no-op)。

4.3 イベントスキーマ

4.3.1 ベース構造

type WebhookEventBase = {
  type: string
  timestamp: string          // ISO8601
  requestId?: string         // 将来的に導入、現状は undefined or ランダム
  endpoint: '/agent.dialog' | '/agent.search'
  tenantId?: string          // 現状は 'default'
  latencyMs?: number

  meta?: {
    orchestratorMode?: string          // 'langgraph' | 'local' | 'fallback-local-429' 等
    route?: string                     // '20b' | '120b' 等
    groq429Fallback?: boolean
    hasLanggraphError?: boolean
    groqBackoffRemainingMs?: number | null

    ragStats?: {
      search_ms?: number
      rerank_ms?: number
      rerank_engine?: 'heuristic' | 'ce' | 'ce+fallback'
      total_ms?: number
    }

    // Phase6: Clarification プロンプトを返したかどうか
    needsClarification?: boolean
  }

  error?: {
    name: string
    message: string
    stack?: string
  }
}

4.3.2 イベントタイプ
	•	agent.dialog.completed
	•	/agent.dialog が正常終了したとき（LangGraph / local 問わず）。
	•	agent.dialog.fallback
	•	LangGraph 経由が失敗し、runDialogTurn にフォールバックしたとき。
	•	特に GroqRateLimitError（429）によるフォールバックを明示したい。
	•	agent.dialog.error
	•	/agent.dialog ハンドラが catch に入り、500 を返したとき。
	•	agent.search.completed / agent.search.error
	•	/agent.search 用。Phase6 で agent.search.completed / agent.search.error も実装済み。

4.3.3 例: agent.dialog.completed

{
  "type": "agent.dialog.completed",
  "timestamp": "2025-11-18T12:34:56.789Z",
  "endpoint": "/agent.dialog",
  "tenantId": "default",
  "latencyMs": 842,
  "meta": {
    "orchestratorMode": "langgraph",
    "route": "20b",
    "groq429Fallback": false,
    "hasLanggraphError": false,
    "groqBackoffRemainingMs": 0,
    "ragStats": {
      "search_ms": 500,
      "rerank_ms": 200,
      "rerank_engine": "ce",
      "total_ms": 730
    }
  }
}

4.3.4 例: agent.dialog.fallback (Groq 429)

{
  "type": "agent.dialog.fallback",
  "timestamp": "2025-11-18T12:34:56.789Z",
  "endpoint": "/agent.dialog",
  "tenantId": "default",
  "latencyMs": 1234,
  "meta": {
    "orchestratorMode": "fallback-local-429",
    "route": "20b",
    "groq429Fallback": true,
    "hasLanggraphError": true,
    "groqBackoffRemainingMs": 10000
  },
  "error": {
    "name": "GroqRateLimitError",
    "message": "429 from Groq (rate limit)",
    "stack": "..."
  }
}

4.3.5 例: agent.dialog.error (500)

{
  "type": "agent.dialog.error",
  "timestamp": "2025-11-18T12:34:56.789Z",
  "endpoint": "/agent.dialog",
  "tenantId": "default",
  "latencyMs": 300,
  "error": {
    "name": "Error",
    "message": "Dialog agent failed"
  }
}

4.4 実装ポイント
	•	新規ファイル: src/integration/webhookNotifier.ts

export type AgentWebhookEvent = WebhookEventBase & { ... }

export class WebhookNotifier {
  constructor(private logger: pino.Logger) {}

  async send(event: AgentWebhookEvent): Promise<void> {
    const url = process.env.N8N_WEBHOOK_URL
    if (!url) return

    const timeoutMs = Number(process.env.N8N_WEBHOOK_TIMEOUT_MS || 2000)
    const extraHeader = process.env.N8N_WEBHOOK_AUTH_HEADER

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (extraHeader) {
      const [k, v] = extraHeader.split(':', 2)
      if (k && v) headers[k.trim()] = v.trim()
    }

    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      this.logger.warn({ err, url }, 'failed to send webhook event')
    }
  }
}

	•	createAgentDialogHandler / createAgentSearchHandler への依存注入（シグネチャ拡張）

export function createAgentDialogHandler(
  logger: pino.Logger,
  deps?: { webhookNotifier?: WebhookNotifier },
) { ... }

	•	/agent.dialog 内での呼び出しタイミング:
	•	LangGraph 成功パス:
	•	agent.dialog.completed
	•	LangGraph → local フォールバック時:
	•	agent.dialog.fallback
	•	ハンドラ catch（500）:
	•	agent.dialog.error
	•	latencyMs は既に startedAt からの差分を計測しているので、それをそのまま流用。

⸻

5. n8n 連携の責務分担

5.1 SaaS 側（commerce-faq-tasks）
	•	HTTP API 提供
	•	/agent.dialog / /agent.search 他
	•	認証レイヤー（API Key / Basic）
	•	各リクエスト単位の raw メトリクス 送信
	•	latencyMs
	•	meta.ragStats.total_ms / search_ms / rerank_ms / rerank_engine
	•	groq429Fallback / hasLanggraphError 等
	•	Webhook エラーハンドリング（fail-safe）

5.2 n8n 側
	•	Webhook Trigger でイベント受信
	•	条件分岐 / フィルタリング
	•	例: latencyMs > 1500 や type == "agent.dialog.fallback" のみなど
	•	後続ノードでアクション実行
	•	Slack 通知
	•	Notion DB 登録
	•	チケット発行（Jira / Linear など）
	•	必要ならメトリクス集計
	•	p50/p95 を Code ノードや外部 BI と連携して算出する

⸻

6. 互換性・移行方針
	•	/agent.dialog / /agent.search の リクエスト / レスポンス JSON 形式は変更しない。
	•	既存のフィールドに加えて meta 内の情報を拡張するのみ。
	•	認証 / Webhook どちらも env 未設定時は無効 とし、Phase5 までの挙動と完全互換。
	•	認証が有効になった場合、既存クライアントは
	•	X-API-Key ヘッダ
	•	または Authorization: Basic ...
を追加すればそのまま利用可能。

⸻

7. この設計を元にした具体的タスク（Issue 紐づけ）
	•	Issue 2: /agent.dialog & /agent.search に API 認証を導入
	•	本ドキュメントの 3 章に対応。
	•	Issue 3: Webhook 通知モジュール実装
	•	本ドキュメントの 4 章に対応。
	•	Issue 4〜6: n8n ガイド & Workflow サンプル
	•	本ドキュメントの 5 章を具体化。
	•	Issue 7: メトリクス / p95 の扱い（外部集計ポリシーの明文化）
	•	本ドキュメント全体のメトリクス方針の補強。
	•	Issue 8: Phase7 (CrewAI) へのブリッジ設計
	•	本ドキュメントを前提に、どこに CrewAI を挿すかを整理。

⸻
```
