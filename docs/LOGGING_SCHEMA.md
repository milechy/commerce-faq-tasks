# Logging Schema（Phase12）

## 🎯 目的

AaaS の実行経路・Planner 利用状況・RAG 品質を  
完全に可視化するためのログ定義。

---

# 1. dialog.run.start

```
{
  tenantId,
  locale,
  preview,
  conversationId
}
```

---

# 2. dialog.rag.start / dialog.rag.finished

```
dialog.rag.finished:
  documents: number
  searchMs: number
  rerankMs: number
  rerankEngine: "heuristic"
  totalMs
```

---

# 3. dialog.planner.rule-based / dialog.planner.llm

```
{
  intentHint,
  route,
  reasons: ["rule-based:shipping"]
}
```

```
dialog.planner.llm:
  llm: "groq/compound-mini"
  latencyMs
  userMessagePreview
```

---

# 4. dialog.clarify.emit

```
{
  questions: [...]
}
```

---

# 5. dialog.answer.finished

```
{
  latencyMs
}
```

---

# 6. meta フィールド

- route
- graphVersion
- ragStats
- plannerReasons
- salesMeta（upsellTriggered / ctaTriggered）
- requiresSafeMode（未使用）

---

# 7. Webhook 連携（n8n）

- agent.dialog.completed
- agent.dialog.clarify_needed
- agent.dialog.error
- slow_request

---

# 8. usage_logs（日次集計）

Billing / Usage 分析のために、コア API の呼び出しを日次 × テナント単位で集計したテーブル。

想定スキーマ（概念）:

- `date` (date) … 集計日
- `tenant_id` (uuid) … テナント ID
- `total_requests` (int) … 当日全リクエスト数
- `dialog_requests` (int) … `/agent.dialog` 呼び出し回数
- `search_requests` (int) … `/agent.search` / `/search.v1` 呼び出し回数
- `hp_sessions` (int) … HP/LP ナビゲーション系のセッション数（必要に応じて）
- `tokens_in` (bigint) … LLM 入力トークン合計
- `tokens_out` (bigint) … LLM 出力トークン合計
- `cost_llm` (numeric) … LLM 原価（最小通貨単位）
- `cost_total` (numeric) … マージン込みコスト
- `billing_status` (text) … `pending` / `billed` / `error` などのステータス

備考:

- `usage_logs` は Billing フローの「単一の集計ソース」として扱い、Stripe / Notion / 管理 UI のいずれもここから見ることを前提とする。
- 生の pino ログや SalesLogs とは別に、Billing/Usage 用の専用サマリテーブルとして運用する想定。
