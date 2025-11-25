# Commerce-FAQ MVP — 開発プロジェクト README

本プロジェクトは **Issues + Labels + PRの自動クローズ** だけで管理します（GitHub Projects不要）。
詳細運用は `AGENTS.md` を参照。


## API仕様リンク（Phase2）

- Agent API 詳細仕様: `docs/API_AGENT.md`
  - `/agent.search` など Phase2 以降のエンドポイントはすべてここに集約
  - README では概要リンクのみを保持し、詳細は本ファイルに記述する

## Phase2 完了サマリ
Phase2（Agent-Based FAQ検索）は以下の要素をすべて完了済みです：

### 🔧 Agent コア機能
- `/agent.search` エンドポイント実装
- Agent Pipeline（plan → search → rerank → synthesis）構築
- Request Validation（Zod）対応
- エージェント内部ステップログ（`steps[]`）返却

### 🧠 Query Planner
- Rule-based Planner（日本語正規化）
- Async Planner（同期互換）
- LLM Query Planner（JSONパース + fallback）
- Runtimeの環境変数で LLM Planner をオン/オフ
- HTTP 引数 `useLlmPlanner` で LLM 経路を選択可能

### 🔍 Agent Tools
- Search Tool（ES + PG ハイブリッド検索）
- Rerank Tool（Cross-Encoder ONNXRuntime）
- Synthesis Tool（回答テンプレ調整 + 箇条書き2件化）

### 🧪 テスト
- Query Planner（sync/async/LLM）単体テスト
- SearchAgent（LLMフラグ含む）テスト
- HTTPテスト（200/400系 + LLMフラグ）
- すべてのテストがグリーン

### ⚡ パフォーマンス
- `perf_agent.sh` / `perf_agent_budget.sh` を追加
- p95 ≈ 50ms, RPS ≈ 1400 を確認

## Phase5 簡易サマリ（Groq / Dialog / RAG パフォーマンス）

Phase5 では、実装リポジトリ側の LangGraph ベース `/agent.dialog` と RAG ハイブリッド検索に対して、

- Groq 429 / 500 時の graceful degradation（local fallback）
- Groq 呼び出し単位のレイテンシ観測（`tag: planner / answer / summary`）
- `/agent.search` / `/agent.dialog` の p50/p95 ベンチマークスクリプト整備
- RAG 再ランク（Cross-Encoder）がボトルネックでないことの確認

を行った。

### 🧪 ベンチ & ログの入口

- RAG ベンチ:
  - `npx ts-node SCRIPTS/bench-agent-search.ts`
- Dialog ベンチ:
  - `BENCH_N=100 npx ts-node SCRIPTS/bench-agent-dialog.ts`

- Groq 呼び出しログ（成功 / 429 / 500）:

    ```bash
    tail -f logs/app.log \
      | jq 'select(.msg=="Groq call success"
                or .msg=="Groq call failed (non-429)"
                or .msg=="Groq 429, backing off before retry"
                or .msg=="Groq 429 after retries, giving up")
            | {msg, tag, model, latencyMs, attempt, status, retryAfterMs, backoffUntil}'
    ```

- `/agent.dialog` orchestrator サマリ:

    ```bash
    tail -f logs/app.log \
      | jq 'select(.msg=="agent.dialog final summary")
            | {orchestratorMode, groq429Fallback, hasLanggraphError,
               durationMs, ragTotalMs, ragSearchMs, ragRerankMs}'
    ```

### 📌 メモ（2025-11 時点）

- Groq API（`groq/compound-mini`）が一時的に HTTP 500 を返す状態を確認しており、
  - その間は `/agent.dialog` が `orchestratorMode: "local"` で動作するケースが増える
  - Groq 正常時の p50/p95 ベースラインは、API 復旧後に再ベンチ予定
- RAG 側は、`/agent.search` ベンチにより
  - search_ms p95 が数十 ms 程度
  - rerank_ms が 0〜1ms 程度
  であることを確認しており、現状のボトルネックは LLM（Groq）側である。

## Phase8: LangGraph / Multi-Agent Orchestration（/agent.dialog 強化）

Phase8 では `/agent.dialog` が **LangGraph Orchestrator** ベースへ全面移行し、従来の Multi‑Step Planner に加えて次の機能が追加された：

### 🧩 LangGraph 芸体系（Planner → Clarify → Search → Sales → Answer → Final）
- **plannerNode**: Groq 20B/120B により Clarify / Propose / Recommend / Close の 4段 SalesStage を生成
- **clarifyNode**: 不足情報のヒアリング（Clarify 質問）
- **searchNode**: Phase3 の ES/BM25 + pgvector ハイブリッド検索 + rerank
- **salesNode**: SalesPipeline を用いて Upsell / CTA（購入・予約意図）を判定し `salesMeta` を構築
- **answerNode**: Answer LLM による最終応答生成（safe-mode あり）
- **finalNode**: UI 用レスポンス構築（steps / salesMeta / plannerPlan / graphVersion）

### 🧠 SalesPipeline（Upsell / CTA 検出）
- PlannerPlan（SalesStage）とユーザー発話から **営業文脈メタ（salesMeta）** を抽出：
  - `upsellTriggered: boolean`
  - `ctaTriggered: boolean`
  - `notes: string[]`（どのロジックが発火したかを可視化）
- ルールは `SalesRules` として外部化済み（将来 Notion / DB からロード可能）

### 📤 /agent.dialog のレスポンス拡張
LangGraph モードでは次の追加メタデータが返却される：

```jsonc
{
  "steps": [
    { "stage": "clarify", ... },
    { "stage": "recommend", ... },
    { "stage": "close", "cta": "purchase" }
  ],
  "meta": {
    "plannerPlan": { "steps": [...] },
    "salesMeta": {
      "upsellTriggered": true,
      "ctaTriggered": true,
      "notes": [
        "planner:recommend-with-upsell-hint",
        "planner:cta:purchase",
        "heuristic:upsell-keyword-detected"
      ]
    },
    "graphVersion": "langgraph-v1"
  }
}
```

### ✔ 安定稼働のためのテスト
- `test:agent:graph` : LangGraph 全体の smoke test
- `test:agent:sales` : SalesPipeline（Upsell/CTA判定）の単体テスト

---

## 進め方（最小）
1. **Issue起票**（テンプレ：`3_TASKS.md` 参照 or `5_SCRIPTS/new_task_template.sh`）
2. **ブランチ作成**：`<type>/<slug>-<#>` 例: `feat/rag-hybrid-perf-4`
3. **PR本文**に `Closes #<番号>` を入れる（マージで自動Close）
4. ステータスは **ラベル付替え**：`status:todo → in-progress → review → qa → done`

## ラベル
- status: `todo / in-progress / review / qa / done`
- prio:   `high / medium / low`
- type:   `feat / bug / chore / ops`
- phase:  `db / api / ui / billing / monitoring / ci`

> ラベルの作成済み確認：`gh label list -R milechy/commerce-faq-tasks`