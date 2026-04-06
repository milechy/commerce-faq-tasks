# RAJIUCE Architecture Diagrams

Mermaid記法で記述したアーキテクチャ図集。GitHubで直接レンダリング可能。

---

## 1. システム全体図（C4 Context）

```mermaid
graph TB
  subgraph users [ユーザー]
    EndUser[エンドユーザー<br>パートナーサイト訪問者]
    Partner[パートナー管理者]
    SuperAdmin[スーパー管理者<br>RAJIUCE運営]
  end

  subgraph edge [エッジ / 配信]
    Widget["Widget.js<br>Shadow DOM<br>1行埋め込み"]
    AdminUI["Admin UI<br>React + Vite<br>admin.r2c.biz"]
  end

  subgraph server [Express API — api.r2c.biz / port 3100]
    Security["セキュリティスタック<br>rateLimiter → auth → tenantContext → securityPolicy"]
    Chat["POST /api/chat<br>POST /dialog/turn"]
    Admin["GET/POST /v1/admin/*<br>JWT Bearer"]
    RAGRoute["POST /agent.search"]
  end

  subgraph rag [RAG Pipeline]
    ES[(Elasticsearch<br>BM25 Top-50)]
    PG[(PostgreSQL<br>pgvector Top-50)]
    CE[Cross-encoder<br>Reranker Top-5]
  end

  subgraph llm [LLM Layer]
    Groq20["Groq Llama 3.3 70B<br>default"]
    Groq120["Groq Llama 3<br>120B complex/safety ≤10%"]
    Gemini["Gemini 2.5 Flash<br>Judge + Book Structurizer"]
    Embed["OpenAI Embeddings<br>text-embedding-3-small"]
  end

  subgraph ext [外部サービス]
    Supabase["Supabase Auth<br>JWT / Storage"]
    Stripe["Stripe Billing<br>metered usage"]
    LiveKit["LiveKit WebRTC"]
    FishAudio["Fish Audio TTS<br>日本語音声合成"]
    Lemonslice["Lemonslice Avatar"]
    Sentiment["Sentiment Service<br>BERT FastAPI port 8200"]
  end

  subgraph infra [インフラ]
    Nginx["Nginx リバースプロキシ<br>SSL Let's Encrypt"]
    PM2["PM2 プロセスマネージャ"]
    Prom["Prometheus + Grafana<br>メトリクス監視"]
    Slack["Slack Webhook<br>AlertEngine"]
  end

  EndUser -->|"チャット"| Widget
  Partner -->|"管理画面"| AdminUI
  SuperAdmin -->|"管理画面"| AdminUI

  Widget -->|"POST /api/chat x-api-key"| Nginx
  AdminUI -->|"JWT Bearer"| Nginx
  Nginx --> PM2
  PM2 --> Security
  Security --> Chat & Admin & RAGRoute

  Chat --> ES & PG
  RAGRoute --> ES & PG
  ES & PG --> CE
  CE --> Groq20 & Groq120
  Chat --> Gemini
  Chat --> Embed

  Admin --> Supabase
  Admin --> Stripe
  Admin --> Gemini

  Chat -->|"Avatar有効時"| LiveKit
  LiveKit --> FishAudio & Lemonslice
  Chat --> Sentiment

  PM2 --> Prom
  Prom --> Grafana["Grafana"]
  Prom --> Slack
```

---

## 2. チャットリクエストフロー（Sequence）

```mermaid
sequenceDiagram
  participant W as Widget.js
  participant N as Nginx
  participant MW as Global Middleware
  participant S4 as 4層セキュリティ<br>rateLimiter→auth<br>tenantCtx→secPolicy
  participant L58 as LLM防御 L5-L8<br>InputSanitizer→<br>PromptFirewall→<br>TopicGuard→<br>OutputGuard
  participant D as DialogOrchestrator
  participant RAG as RAG Pipeline<br>ES + pgvector<br>Cross-encoder
  participant SF as SalesFlow<br>clarify→propose→<br>recommend→close
  participant LLM as Groq 70B/120B
  participant J as Judge<br>Gemini 2.5 Flash

  W->>N: POST /api/chat {message, conversationId}
  N->>MW: x-api-key, X-Tenant-ID
  MW->>MW: requestId / secHeaders / CORS
  MW->>S4: per-route stack
  S4->>S4: rateLimiter (IP+key)
  S4->>S4: authMiddleware (SHA-256 key verify)
  S4->>S4: tenantContextLoader (JWT→tenantId)
  S4->>S4: securityPolicyEnforcer (origin check)
  S4->>L58: message sanitization
  L58->>L58: L5 Input Sanitizer
  L58->>L58: L6 Prompt Firewall
  L58->>L58: L7 Topic Guard
  L58->>D: sanitized message
  D->>SF: SalesFlow stage check
  D->>RAG: semantic + keyword search
  RAG-->>D: top-5 ranked excerpts (≤200 chars)
  D->>LLM: system_prompt + RAG + psych principles
  LLM-->>D: response draft
  D->>L58: L8 Output Guard
  L58-->>W: filtered response
  D-->>J: async Judge evaluation
  J-->>D: score (4軸) + tuning suggestions
```

---

## 3. データフロー図（行動データ → コンバージョン最適化）

```mermaid
graph LR
  subgraph collect [Phase55: 行動イベント収集]
    BE[behavioral_events<br>scroll / time_on_page<br>page_transition]
  end

  subgraph score [Phase55: スコアリング]
    TS[temperatureScoring<br>スクロール深度×滞在時間<br>×訪問ページ数]
    TEMP[visitor_temp_score<br>0-100]
  end

  subgraph engage [Phase56: プロアクティブ]
    TR[trigger_rules<br>閾値チェック]
    PE[ProactiveEngine<br>介入タイミング最適化]
    AB1[A/Bテスト<br>メッセージバリアント]
  end

  subgraph agent [Phase57: コンテキストアウェアAgent]
    CTX[Context Builder<br>device + page + score]
    PSY[psychologySelector<br>書籍RAG原則選択]
    BOOK[book_chunks<br>pgvector + ES<br>6フィールド構造化]
    SYNTH[synthesisTool<br>Groq 70B]
  end

  subgraph store [データ永続化]
    CM[chat_messages<br>psychology_principle_used<br>visitor_temp_score<br>sales_stage]
    CA[conversion_attributions<br>コンバージョン記録]
  end

  subgraph optimize [Phase58: 最適化ループ]
    JUDGE[Judge Evaluator<br>Gemini 2.5 Flash<br>4軸スコアリング]
    AB2[ab_experiments<br>勝者バリアント選定]
    TUNE[auto_tuning<br>チューニングルール<br>自動提案]
    REPORT[weekly_reports<br>Slack通知]
  end

  BE --> TS --> TEMP
  TEMP --> TR --> PE
  PE --> AB1
  AB1 --> CTX
  CTX --> PSY
  BOOK -->|RAG検索| PSY
  PSY --> SYNTH
  SYNTH --> CM
  CM --> CA
  CM --> JUDGE
  JUDGE --> AB2 --> TUNE
  JUDGE --> REPORT
  TUNE -->|フィードバック| PSY
```

---

## 参照

- システム全体: [`ARCHITECTURE.md`](../ARCHITECTURE.md)
- セキュリティ: [`docs/auth.md`](auth.md)
- Phase詳細: [`PHASE_ROADMAP.md`](../PHASE_ROADMAP.md)
- 戦略ビジョン: [`docs/R2C_STRATEGIC_VISION.md`](R2C_STRATEGIC_VISION.md)
