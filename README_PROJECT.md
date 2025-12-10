# Commerce-FAQ MVP — 開発プロジェクト README

本プロジェクトは **Issues + Labels + PR の自動クローズ** だけで管理します（GitHub Projects 不要）。
詳細運用は `AGENTS.md` を参照。

## API 仕様リンク（Phase2）

- Agent API 詳細仕様: `docs/API_AGENT.md`
  - `/agent.search` など Phase2 以降のエンドポイントはすべてここに集約
  - README では概要リンクのみを保持し、詳細は本ファイルに記述する

## Phase2 完了サマリ

Phase2（Agent-Based FAQ 検索）は以下の要素をすべて完了済みです：

### 🔧 Agent コア機能

- `/agent.search` エンドポイント実装
- Agent Pipeline（plan → search → rerank → synthesis）構築
- Request Validation（Zod）対応
- エージェント内部ステップログ（`steps[]`）返却

### 🧠 Query Planner

- Rule-based Planner（日本語正規化）
- Async Planner（同期互換）
- LLM Query Planner（JSON パース + fallback）
- Runtime の環境変数で LLM Planner をオン/オフ
- HTTP 引数 `useLlmPlanner` で LLM 経路を選択可能

### 🔍 Agent Tools

- Search Tool（ES + PG ハイブリッド検索）
- Rerank Tool（Cross-Encoder ONNXRuntime）
- Synthesis Tool（回答テンプレ調整 + 箇条書き 2 件化）

### 🧪 テスト

- Query Planner（sync/async/LLM）単体テスト
- SearchAgent（LLM フラグ含む）テスト
- HTTP テスト（200/400 系 + LLM フラグ）
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

- **plannerNode**: Groq 20B/120B により Clarify / Propose / Recommend / Close の 4 段 SalesStage を生成
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
- `test:agent:sales` : SalesPipeline（Upsell/CTA 判定）の単体テスト

## Phase11: Dialog Runtime Hardening（LangGraph + CrewGraph + Logging）

Phase11 では `/agent.dialog` の **実行基盤の安定化と計測まわり** を中心に、LangGraph / CrewGraph を本番運用を想定した形に仕上げた。

### 🔁 Runtime / Orchestrator 層

- HTTP 層のロジックを **AgentDialogOrchestrator** に集約し、`/agent.dialog` のハンドラは薄い HTTP アダプタのみに整理
- AgentDialogOrchestrator → CrewOrchestrator → LangGraphOrchestrator の実行パスを標準化
- LangGraph runtime 向けに `langGraphOrchestrator.test.ts` を追加し、planner/clarify/search/answer/final の一連フローをスモークテスト

### 👥 CrewGraph 統合

- CrewGraph（Input / Planner / Kpi / Final）のノード配線を整理し、`CrewGraph.test.ts` で linear flow を検証
- PlannerNode は LangGraph runtime をラップする形に統一し、CrewGraph と LangGraph の整合性を担保

### 📊 レイテンシ計測 / ログ

- RAG / Planner / Answer 向けに以下のログを統合:
  - `dialog.rag.finished`（`totalMs`, `searchMs`, `rerankMs`）
  - `tag: "planner"`（Planner LLM の `latencyMs`）
  - `dialog.answer.finished`（Answer LLM の `latencyMs`）
  - `agent.dialog.orchestrator.response`（`route`, `graphVersion`, `needsClarification`, `hasPlannerPlan`, `hasKpiFunnel`, `kpiFunnelStage` など）
- `src/SCRIPTS/analyze-agent-logs.ts` を追加し、pino JSON ログから
  - RAG (`dialog.rag.finished.totalMs`)
  - Planner (`tag=planner.latencyMs`)
  - Answer (`dialog.answer.finished.latencyMs`)
    の p50 / p95 を集計できる CLI を整備

### 🧠 Planner 軽量化のためのフック

- `buildRuleBasedPlan(input, intent)` を定義した Rule-based Planner スケルトンを追加（Phase11 時点では常に `null` を返し挙動は変更しない）
- `plannerNode` 内で intent ヒント（shipping / returns / payment / product-info / general）を元に Rule-based Planner を呼び出すフックを実装
- 将来 Phase12 以降で shipping / returns などの定型問い合わせを Rule-based Planner に寄せることで、Planner LLM 呼び出し頻度を下げて p95 を削減できる構造を用意

## Phase12: Planner 軽量化 / Fast-path / p95 計測

Phase12 では、Phase11 で用意していた Rule-based Planner フックとログ基盤を活用し、次を実施した。

- shipping / returns / product-info 向けの Rule-based Planner を実装し、missing 判定 → Clarify → fallback のルールを確定
- simple な general FAQ 向けに Fast-path を導入し、Planner LLM をスキップして RAG→Answer のみで応答
- `/agent.dialog` ログから RAG / Planner / Answer の p50/p95 を集計する `SCRIPTS/analyze-agent-logs.ts` を整備
- Planner LLM 呼び出し頻度を 5〜10% 程度に抑える構造を確認

詳細仕様は、実装リポジトリ側の `docs/PHASE12_SUMMARY.md` を参照。

## 進め方（最小）

1. **Issue 起票**（テンプレ：`3_TASKS.md` 参照 or `5_SCRIPTS/new_task_template.sh`）
2. **ブランチ作成**：`<type>/<slug>-<#>` 例: `feat/rag-hybrid-perf-4`
3. **PR 本文**に `Closes #<番号>` を入れる（マージで自動 Close）
4. ステータスは **ラベル付替え**：`status:todo → in-progress → review → qa → done`

## ラベル

- status: `todo / in-progress / review / qa / done`
- prio: `high / medium / low`
- type: `feat / bug / chore / ops`
- phase: `db / api / ui / billing / monitoring / ci`

> ラベルの作成済み確認：`gh label list -R milechy/commerce-faq-tasks`

## Phase13: Notion-driven Sales AaaS Foundation（Clarify / Templates / Logs）

Phase13 では、英会話テナント向け Sales AaaS の基盤として、Notion を外部データソースとする構造を追加した。

### 🗂 Notion Sync（FAQ / Products / LP Points / TuningTemplates）

- 新インテグレーション `commerce-faq-phase13` を利用
- `pnpm sync:notion` により、4 つの DB を Postgres に同期
- 起動時には TuningTemplates のみ自動同期し、SalesTemplateProvider にロードされる

### 🧩 Sales Templates Externalization（Clarify）

- TuningTemplates DB から Clarify テンプレを取得
- `registerNotionSalesTemplateProvider()` により外部テンプレを SSOT 化
- `buildClarifyPrompt()` で Clarify を生成（Notion → fallback の優先順）

### 🧠 英会話 Intent 拡張（Phase13 範囲）

- `level_diagnosis`
- `goal_setting`
  ClarifyIntent に追加し、テンプレと ClarifyFlow が利用可能に。

### 📝 Clarify Log → Notion 書き戻し

- `/integrations/notion/clarify-log` を実装
- Clarify 発生時に Notion DB へ create
- 必須プロパティ：Original / Clarify / Missing / Intent / TenantId

### 📘 新規ドキュメント（docs/phase13）

- NOTION_SYNC.md
- TUNING_TEMPLATES_SPEC.md
- CLARIFY_FLOW.md
- CLARIFY_LOG_SPEC.md
- SALES_TEMPLATE_PROVIDER.md
- ENVIRONMENT.md
- PHASE13_SUMMARY.md

### 🚀 Phase14 への接続ポイント

- Propose / Recommend / Close テンプレ外部化
- SalesFlow（Clarify → Propose → Recommend → Close）
- Intent taxonomy 拡張
- Clarify Log を使った改善サイクル

## Phase15: SalesFlow Control / Sales Logs / KPI Reports

Phase15 では、英会話テナント向け SalesFlow を **Clarify → Propose → Recommend → Close → Ended** まで一貫して制御・観測できるようにした。

### 🧠 Sales Intent Rules（YAML）

- `config/salesIntentRules.yaml` に SalesFlow 用 Intent ルールを集約
- `salesIntentDetector.ts` で YAML をロードし、Propose / Recommend / Close の intent 候補を検出
- YAML 読み込み失敗時は legacy ルールに自動フォールバックする安全設計
- 詳細: `docs/INTENT_DETECTION_RULES.md`

### 🔁 SalesStage Machine / Orchestrator 統合

- `salesStageMachine.ts` により、`clarify / propose / recommend / close / ended` の状態遷移を明示的に管理
- `computeNextSalesStage()` が `prevStage / nextStage / stageTransitionReason` を返し、SalesOrchestrator がそれに従ってテンプレ生成を実行
- Orchestrator 入口として `runSalesFlowWithLogging` を導入し、ステージ制御・テンプレ選択・ログ書き込みを一か所で行う構造に統一
- 詳細: `docs/SALESFLOW_DESIGN.md`, `docs/SALESFLOW_RUNTIME.md`

### 📝 SalesLogWriter / Sales Log Spec（Phase15）

- SalesLog を Clarify / Propose / Recommend / Close 全体で共通フォーマット化
- ログ項目:
  - `phase`, `prevStage`, `nextStage`, `stageTransitionReason`
  - `intent`, `personaTags`, `userMessage`
  - `templateSource`（`notion` / `fallback`）
  - `templateId`, `templateText`, `promptPreview`
- SalesLogWriter により、将来の Postgres 保存にも対応可能な adapter 構造を定義
- 詳細: `docs/SALES_LOG_SPEC.md`

### 📊 Template Fallback / KPI レポート CLI

- TemplateMatrix（phase × intent × personaTag）と SalesLog をもとに、Fallback 状況を可視化:
  - `SCRIPTS/convertTemplateMatrixCsvToJson.ts`
  - `SCRIPTS/convertSalesLogsCsvToJson.ts`
  - `SCRIPTS/analyzeTemplateFallbacks.ts`
  - `SCRIPTS/run_template_fallback_report.sh`
- Sales KPI Funnel（Stage / Intent / PersonaTag 別）を Markdown レポートとして生成:
  - `SCRIPTS/analyzeSalesKpiFunnel.ts`
  - `SCRIPTS/run_sales_reports.sh`
- これにより、「どの intent / persona で fallback が多いか」「どのステージに滞留しがちか」を定量的に把握できる。

## Phase16: SalesFlow Logging / SalesRulesLoader / SalesSessionMeta

Phase16 では、Phase15 で導入した SalesFlow（Clarify → Propose → Recommend → Close → Ended）を、より安定して **観測・制御・拡張** できるようにするため、次の 3 点を中心に整備した。

### 📝 SalesLog 拡張（ステージ遷移メタ）

- SalesLog に以下のフィールドを追加し、SalesStageMachine の出力と 1:1 で対応付けた:
  - `prevStage`, `nextStage`, `stageTransitionReason`, `timestamp`
- `runSalesFlowWithLogging` → `SalesLogWriter` の経路で、`SalesOrchestratorResult.stageTransition` からステージ遷移メタをログに落とす構造を確立
- `SCRIPTS/analyzeSalesKpiFunnel.ts` を拡張し、SalesLog から
  - Stage Distribution
  - Stage Transitions（from/to/count）
  - Funnel Metrics（clarify → propose → recommend → close）
  を集計できるようにした（サンプルログ: `data/sales_logs.json`）

### ⚙️ SalesRulesLoader（テナント別 SalesRules 差し替え）

- `SalesRulesLoader` インターフェースと `DefaultSalesRulesLoader` を追加し、将来 Notion / DB などから SalesRules をロードできる入口を用意
- `initSalesRulesProviderFromLoader` / `initDefaultSalesRulesProvider` により、起動時に `SalesRulesProvider` を初期化する経路を標準化
- テナント単位で SalesRules を差し替え可能な構造を `tests/agent/rulesLoader.test.ts` / `tests/agent/salesRulesLoader.test.ts` / `src/agent/orchestrator/sales/rulesLoader.test.ts` で検証

### 💾 SalesSessionMeta / salesContextStore（Sales セッション状態の保存）

- `SalesSessionMeta` 型を定義し、Sales セッションごとのメタ情報を in-memory で管理:
  - `currentStage`, `lastIntent?`, `personaTags?`, `lastUpdatedAt`
- `SalesSessionKey { tenantId, sessionId }` を導入し、テナント + セッション単位でセッションメタを管理
- `salesContextStore.ts` に `get/set/update/clearSalesSessionMeta` を実装し、`salesContextStore.test.ts` でユニットテストを整備
- `dialogAgent.ts` から `runSalesFlowWithLogging` 実行後に `salesResult.nextStage` を `SalesSessionMeta.currentStage` として保存することで、「このセッションはいまどの SalesStage にいるか」を後続処理で参照できるようにした

詳細は `docs/PHASE16_SUMMARY.md` および `docs/SALES_LOG_SPEC.md` / `docs/SALES_ANALYTICS.md` / `docs/SALESFLOW_DESIGN.md` / `docs/SALESFLOW_RUNTIME.md` を参照。
