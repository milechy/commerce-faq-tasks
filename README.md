# Commerce-FAQ SaaS — 開発HQ / タスク管理リポジトリ

このリポジトリは **プロダクト実装コードではなく**、AI FAQサービス *Commerce-FAQ SaaS* の「開発HQ（Docs・ワークフロー・タスク運用）」をまとめるためのリポジトリです。GitHub Issues/Labels/PR を中心に、Notionで定義した各種アーキテクチャ/Runbookを開発の実務に落とし込みます。

---
## 目的
- タスク管理：GitHub Issues + Labels（`status/prio/type/phase`）で軽量運用
- ドキュメント集約：アーキ・運用・価格/Billing・オンボーディングをここにリンク
- 自動化：`SCRIPTS/` のスクリプトでラベル/起票フローを最短化

---
## プロダクト要約（再掲）
- サービス名: **Commerce-AaaS（Sales Assistant as a Service）**
- 目的: HP/LP/FAQ すべてを横断し、顧客の目的達成（購買・予約・問い合わせ）を支援する AI セールスアシスタント
- コア機能: FAQ応答 + 商品レコメンド + キャンペーン案内 + クーポン提示 + ページ誘導
- モデル: Groq GPT-OSS 20B / 120B（Claude 互換 Prompt でベイズ誘導も可能）
- RAG構成: pgvector（Hetzner）+ Elasticsearch（Hetzner）+ Web検索（Compound内蔵）
- インフラ: Cloudflare（WAF/CDN）+ Hetzner（DB/ES）+ n8n Cloud（Automation）
- 料金: 従量課金（Sales + FAQ）＋ テナント初期セットアップ（RAG整備＋チューニング）

---
## 主なドキュメント
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — システム全体像 / 技術構成（Mermaid含む）
- [`REQUIREMENTS.md`](REQUIREMENTS.md) — 追加要件（グローバル展開、モデル、価格、プロンプト圧縮など）
- [`AGENTS.md`](AGENTS.md) — AIエージェント（Claude/Copilot/Codex）向け操作ガイド & gh CLI テンプレ
- [`README_PROJECT.md`](README_PROJECT.md) — GitHub Projects を使うときの運用ノート（※現在は Issues/Labels 中心）
- [`team-members.md`](team-members.md) — メンバー表（GitHub ID ↔ 呼称マップ）

> Notion 側の参照：Billing Architecture / DevOps & QA Runbook / Onboarding Quick Guide / Implementation Checklist など（各ドキュメントからリンク）

---
## CI / Performance Gate（GitHub Actions）

- ワークフロー: `.github/workflows/perf-gate.yml`
- ローカルと同じチェックをCIで実行します。
  - **ローカル**: `pnpm run perf:gate:strict`
  - **CI**: `pnpm run ci:perf`（Node 20 でビルド → 最良ログを選択 → **RPS ≥ 6000** & **P90 ≤ 14** をゲート）
- 参考コマンド:
  - 最新ログ表示: `pnpm run perf:last`
  - 要約レポート: `pnpm run perf:report`

## タスク運用（Issues + Labels）
**必須ラベル**
- `status:*` → `todo` / `in-progress` / `review` / `qa` / `done`
- `prio:*` → `high` / `medium` / `low`
- `type:*` → `feat` / `bug` / `chore` / `ops`
- `phase:*` → `db` / `api` / `ui` / `billing` / `monitoring` / `ci`

**よく使うコマンド**
```bash
# 1) ラベル初期化（必要に応じて）
./SCRIPTS/env_setup.sh

# 2) タスク起票（テンプレ）
gh issue create -R <owner>/<repo> \
  --title "RAGハイブリッド検索のパフォーマンス最適化" \
  --body  $'目的: p95 ≤1.5s維持のためにRAG再ランクを軽量化。\n対象: pgvector + Elasticsearch 統合。\n完了条件: latency<1.5s, TopK=50, Cross-encoder稼働確認。' \
  --label "type:feat,status:todo,prio:high,phase:api" \
  --assignee "@me"

# 3) ステータス変更（例：todo→in-progress）
gh issue edit <N> -R <owner>/<repo> \
  --add-label "status:in-progress" --remove-label "status:todo"

# 4) ブランチ作成→PR作成→自動クローズ（キーワード）
ISSUE=<N>
BR="feat/scope-$ISSUE"
git checkout -b "$BR" && git push -u origin "$BR"
gh pr create -R <owner>/<repo> -B main -H "$BR" \
  -t "feat: scope (Closes #$ISSUE)" -b $'実装詳細...\n\nCloses #'"$ISSUE"

 以前試していた ProjectのStatus自動更新用Actions は無効化/削除済み。現状は ラベル運用に一本化 しています。

スクリプト

SCRIPTS/env_setup.sh … ラベルの一括作成/整合
SCRIPTS/gh_workflow_shortcuts.sh … gh CLI のショートハンド（任意）
SCRIPTS/new_task_template.sh … 新規タスク雛形（任意）


実行権限がない場合は chmod +x SCRIPTS/*.sh を実行。


セキュリティ/運用メモ（抜粋）

Secrets は Vault/Cloudflare 管理（本リポジトリに秘匿情報を置かない）
Stripe Webhook / Billing同期は 専用サービス 側で実装、HQでは手順書を管理
監視: Datadog/Sentry／パフォーマンスKPI: p95<1.5s, error<1%


QA / 出荷前チェック（チェックリスト）

 Unit/Integration/k6 Pass
 CrewAI 自動レビュー ≥ 90
 Stripe サンドボックス請求 OK
 Cloudflare Rate-limit 動作確認
 Runbook 更新済み / Rollback 手順確認


コントリビューション

Issue を作成し、status:todo と各種メタラベルを付与
ブランチ命名: feat|bug|chore|ops/<scope>-<issue#>
PR の本文に Closes #<issue> を必ず記載
マージ後、必要に応じて status:qa → status:done に手動更新


開発ツール前提

Git / GitHub CLI (gh >= 2.30 目安)
Node/PNPM or Python はこのリポジトリでは不要（アプリ実装は別リポ）


MVP Roadmap（Phase進捗テーブル）
Phase,Status,Due Date,Notes
0: Setup,Done,11/1,Vault/RLS基盤OK
1: DB+RLS,Done,11/5,RLSポリシー統合
2: RAG,Done,11/10,Hybrid検索テスト
3: Routing,Done,11/12,20B/120Bルート
4: API,Done,11/15,FastAPI/JWT
5: UI Widget,In Progress,11/20,Multi-langプレビュー
6: Billing,In Progress,11/25,Stripe/n8n同期
7: Monitoring,Todo,11/28,Datadogアラート
8: CI/CD & QA,Todo,11/30,k6/Tester-H
9: A/B+Lang,Todo,12/5,Toneベイズテスト
10: Release,Todo,12/10,Rollback/GA

変更履歴

2025-11-08: README を初期化（開発HQとしての正しい説明に更新、固定費削除、Roadmap追加）

## Phase5: Agent / LangGraph / RAG パフォーマンス計測メモ

Phase5 では、実装リポジトリ（同名 repo）側の `/agent.search` / `/agent.dialog` に対して、

- Groq 呼び出しの graceful degradation（429/500 時の fallback）
- RAG ハイブリッド検索（ES + PG + 再ランク）の p50/p95 計測
- LangGraph Orchestrator を含む `/agent.dialog` 全体の p50/p95 計測

を一通り実施した。

### ベンチマークスクリプト（実装リポジトリ側）

実装リポジトリ（Node/TypeScript 側）の `SCRIPTS/` に、以下の簡易ベンチを用意している:

- `/agent.search`（RAG 検索のみ）:
  - `npx ts-node SCRIPTS/bench-agent-search.ts`
- `/agent.dialog`（LangGraph Orchestrator 経由）:
  - `BENCH_N=100 npx ts-node SCRIPTS/bench-agent-dialog.ts`

出力例（イメージ）:

```text
N = 100
target = http://localhost:3000/agent.dialog
---
...
===
latency p50/p95: 5029 6374
rag_total_ms p50/p95: 66 150 (N=50)
rag_search_ms p50/p95: 66 150 (N=50)
rag_rerank_ms p50/p95: 0 0 (N=50)
```

※ Groq API が HTTP 500 を返している期間は、/agent.dialog の値が local fallback 寄りになるため、  
Groq 復旧後に再ベンチする想定。

### ログ観測（Groq / Orchestrator / RAG）

ログは `logs/app.log` に JSON で出力される。代表的なウォッチ用コマンド:

- Groq 呼び出し単位（planner / answer / summary / 429 など）:

  ```bash
  tail -f logs/app.log \
    | jq 'select(.msg=="Groq call success"
              or .msg=="Groq call failed (non-429)"
              or .msg=="Groq 429, backing off before retry"
              or .msg=="Groq 429 after retries, giving up")
          | {msg, tag, model, latencyMs, attempt, status, retryAfterMs, backoffUntil}'
  ```

- `/agent.dialog` 最終サマリ（orchestratorMode / fallback / RAG 計測値）:

  ```bash
  tail -f logs/app.log \
    | jq 'select(.msg=="agent.dialog final summary")
          | {orchestratorMode, groq429Fallback, hasLanggraphError,
             durationMs, ragTotalMs, ragSearchMs, ragRerankMs}'
  ```

これにより、

- LangGraph 経路（`orchestratorMode: "langgraph"`）と local 経路（`"local"` / `"fallback-local-429"`）
- Groq の 429（rate limit）/ 500（server error）と、それに伴う fallback の動き
- `/agent.dialog` 全体の duration と、内部の RAG (`rag_*`) のコスト

を定量的に追跡できる。

text---

### 3. `ARCHITECTURE.md`
```markdown
# 改善後アーキテクチャ（要点）

```mermaid
graph TD
A[Client Widget] -->|HTTPS| B[API Gateway]
B --> C[RAG Retriever]
C --> C1[pgvector] & C2[Elasticsearch]
C --> C3[Cross-encoder Re-ranker]
B --> D[Groq LLM (20B/120B)]
B --> E[Commerce Engine]
E --> P[Product/Order DB]
B --> F[Redis Cache]
B --> G[Billing/Usage Logs]
B --> H[Monitoring (Datadog/Otel)]
B --> I[Security (Cloudflare)]
B --> T[Tuning DB (Templates & Tone)]

モデルルーティング
	•	既定: 20B
	•	昇格条件（例）: context_tokens>2000 / recall<0.6 / complexity≥τ / safety_tag ∈ {legal,security,policy}
	•	フォールバック: 20B失敗→120B→静的FAQ→HITL

レスポンス拡張:
{"route":"20b|120b|static|human","rerank_score":0.74,"tuning_version":"r2025.10.22-01","flags":{"uncertain":false,"safe_route":false}}

RAGハイブリッド
	1.	ES Top-50 と pgvector Top-50 を並列
	2.	結合/重複排除→Top-80
	3.	Cross-encoder 再ランク→Top-5
	4.	チャンク要約・重複削除→ ~1.5–2k tokens

k_semantic=50, k_bm25=50, k_final=5, max_context_tokens=2000

A/Bテスト
	•	tone ∈ {Polite, Simple, SalesSoft}
	•	cta_template_id ∈ {cta_v1, v2, v3}
	•	rule_set ∈ {default, upsell, cross}
	•	ベイズAB 勝率>95%で採択

フェイルオーバ
	1.	20B失敗→120B(1回)
	2.	両方失敗→静的FAQ
	3.	API失敗→CFキャッシュ/エラーバナー
	4.	緊急→Circuit Breaker + Ops通知

### Performance Gate

- ローカル最速ログを選んで厳密ゲート：
  ```bash
  pnpm run perf:gate:strict

  ## Phase3: Multi-Step Query Planning & Dialog Orchestrator 概要

Phase3 では、既存の `/agent.search` を壊さずに、対話型 FAQ エージェント `/agent.dialog` と Multi-Step Planner を追加した。

- `/agent.dialog` エンドポイント
  - セッション ID ベースで会話コンテキストを継続
  - `needsClarification` / `clarifyingQuestions` による Clarify フロー
  - `steps` と `meta.orchestrationSteps` により、Planner / Orchestrator の内部ステップログをトレース可能

- Multi-Step Planner
  - `MultiStepQueryPlan` 型を導入（clarify / search / followup_search / answer ステップ）
  - Rule-based Planner と LLM Planner をオプション `useLlmPlanner` で切り替え
  - `llmMultiStepPlannerRuntime.ts` で Groq GPT-OSS 20B/120B を利用した JSON プラン生成を実装

- LLM ルーティング（GPT-OSS 20B/120B）
  - `src/agent/llm/modelRouter.ts` の `routePlannerModel` で 20B/120B のルーティング規則を定義
  - contextTokens / recall / complexity / safetyTag に基づき、昇格条件を判定
  - `LLM_FORCE_PLANNER_ROUTE` によるデバッグ用強制ルートにも対応

- Dialog Orchestrator
  - `runDialogOrchestrator` が Planner / SearchAgent / AnswerAgent を統合
  - Clarify / Follow-up / Search の分岐ロジックを Orchestrator の責務として集約
  - 単体テスト (`dialogOrchestrator.test.ts`) および HTTP E2E テスト (`agentDialogRoute.test.ts`) を追加

- CrewAI / LangGraph 連携のためのポート定義
  - `src/agent/orchestrator/crew/crewSchemas.ts` / `crewClient.ts` で Crew Orchestrator との I/F を定義
  - Phase3 ではポートのみ定義し、実装は Phase4 (Agent Orchestration) で追加予定

---

Phase3 の詳細な設計・API 例・シーケンス図は `docs/PHASE3_MULTISTEP.md` を参照。
# Commerce-AaaS（Sales Assistant as a Service）— 開発HQ / ワークフロー管理リポジトリ

このリポジトリは **AIセールスアシスタント「Commerce-AaaS」** の  
**開発HQ（アーキテクチャ / Docs / タスク運用）を集約するためのリポジトリ** です。

> ⚠️ **プロダクト実装コードは別リポジトリ**  
> ここは開発組織・ワークフロー・アーキ・運用・QA・チューニングの「HQ（司令塔）」です。

---

## 🚀 Commerce-AaaS とは
**FAQ回答だけのサービスではなく、Ruffus（Amazonの販売アシスタント）を超える “能動的AIセールス” AaaS。**

### ✔ 特徴
- HP / LP / FAQ / 商品DB を横断して  
  **「顧客の目的達成（購入・予約・問い合わせ）」を自律的に誘導**
- パートナー（心理学 × 営業の専門家）が  
  **クライアント毎に AI の会話テンプレ・トークスクリプトを Notion でチューニング**
- Multi-Agent（LangGraph / CrewAI）ベースの会話オーケストレーション
- テナント毎に  
  **RAG・営業ロジック・会話トーン・誘導ルール（CTA/UpSell/CrossSell）を完全分離**
- A/Bテスト（トーン・CTA・営業動線）＋ ベイズ最適化で継続改善

---

## 🏗 技術構成（Phase7 時点の確定版）

### 🔍 RAG 基盤
- **Elasticsearch（BM25 Top50）**
- **pgvector（Cosine Top50 / HNSW）**
- 並列検索 → 統合 → CE再ランク → Top5
- Groq embeddings（20B）使用

### 🤖 LLM
- **Groq GPT-OSS 20B / 120B**
- プランナー / 回答 / 要約
- 20B → 120B への自動昇格条件  
  `context_tokens / recall / complexity / safety_tag`

### 🎛 Orchestration
- Multi-Step Planner（Clarify, Search, Follow-up, Answer）
- LangGraph / CrewAI と互換インターフェース設計済  
  → Phase8 でフロー全体を移行予定

### 🗃 ストレージ
- PostgreSQL（Hetzner）
- `faq_docs`（元データ）
- `faq_embeddings`（pgvector）
- `faq_usage`（将来の A/B / ベイズ用）
- Supabase Auth（Admin UI ログイン用）

### 🌐 API（実装リポジトリ）
- `/agent.search`（高速RAG）
- `/agent.dialog`（対話型セールスエージェント）
- `/admin/faqs`（FAQ管理UI用）
- JWT（Supabase発行）による管理画面アクセス

### 🖥 Admin UI
- React + Supabase Auth  
- FAQ作成 / 編集（ES同期 + Embedding同期）  
- テナント切替  
- フィールド：question / answer / category / tags / is_published

---

# 📚 このHQリポジトリの役割
**アプリ実装ではなく、以下を管理するためのリポジトリです：**

### 1. アーキテクチャ
- [`ARCHITECTURE.md`](ARCHITECTURE.md)  
- マイクロサービス構成 / RAGパイプライン / LLMルーティング / 監視 / Billing

### 2. API 仕様
- [`docs/api-agent.md`](docs/api-agent.md)  
- [`docs/api-admin.md`](docs/api-admin.md)

### 3. RAG / 検索パイプライン
- [`docs/search-pipeline.md`](docs/search-pipeline.md)

### 4. DB スキーマ
- [`docs/db-schema.md`](docs/db-schema.md)

### 5. 認証とテナント管理
- [`docs/auth.md`](docs/auth.md)
- [`docs/tenant.md`](docs/tenant.md)

### 6. タスク運用
- Issues / Labels  
- CI / Performance Gate  
- ユーザーオンボーディング手順

> Notion 側の資料は「営業テンプレ」「会話フロー」「A/B 施策」「クライアント要件」  
> ＝ **パートナーが調整する “Sales Playbook DB”** として運用。

---

# 🧭 タスク管理（Issues + Labels）

### 必須ラベル
- `status:*` → todo / in-progress / review / qa / done  
- `prio:*` → high / medium / low  
- `type:*` → feat / bug / chore / ops  
- `phase:*` → db / api / ui / billing / monitoring / ci / agent

### よく使うコマンド（GH CLI）
```bash
# 新規タスク
gh issue create -R <owner>/<repo> \
  --title "pgvector HNSW 最適化" \
  --body "目的: 検索p95を1.0s以下へ。Top80→Top50バランス調査" \
  --label "type:feat,status:todo,prio:high,phase:api" \
  --assignee "@me"
```

---

# 🛠 CI / パフォーマンスゲート

### RAG / Agent 処理の自動性能チェック
- `.github/workflows/perf-gate.yml`
- ローカル：`pnpm run perf:gate:strict`
- CI：`pnpm run ci:perf`

判定基準（例）  
- **RPS ≥ 6000**  
- **P90 ≤ 14ms**

---

# 🗺 MVP Roadmap（Phase0〜7 完了 / Phase8〜10 着手前）

| Phase | Status | Notes |
|-------|--------|-------|
| 0: Setup | Done | Vault / Auth |
| 1: DB+RLS | Done | faq_docs / embeddings |
| 2: RAG | Done | ES+PG+CE統合 |
| 3: Orchestrator | Done | Multi-step planner |
| 4: API | Done | /agent.search / dialog |
| 5: Admin UI | Done | Supabase Auth / CRUD |
| 6: Billing | In Progress | Stripe / n8n |
| 7: Monitoring | In Progress | Datadog / Cloudflare |
| **8: LangGraph** | **Next** | Multi-agent化 |
| **9: A/B + Tuning DB** | **Next** | トーン/CTAベイズ最適化 |
| **10: Release** | **Next** | Rollback + GA |

---

# 📄 変更履歴
- **2025-11-24**: Commerce-AaaS 仕様に全面刷新（①②③反映）
- 2025-11-08: 初期READMEをHQ仕様に更新
# Commerce-AaaS（Sales Assistant as a Service）— 開発HQ / ワークフロー管理リポジトリ

このリポジトリは **AIセールスアシスタント「Commerce-AaaS」** の
**開発HQ（アーキテクチャ / Docs / タスク運用）を集約するためのリポジトリ** です。

> ⚠️ **ここにはアプリ本体の実装コードはありません**  
> 実装は別リポジトリで管理し、このリポジトリは「設計・運用・タスク管理」の司令塔として使います。

---

## 🚀 Commerce-AaaS の概要

- サービス種別: **Sales Assistant as a Service（AaaS）**
- 役割: HP / LP / FAQ / 商品DB を横断し、
  **顧客の目的達成（購入・予約・問い合わせ）を能動的に支援する AI セールスパートナー**
- 位置づけ: Ruffus（Amazon の販売アシスタント）よりも、
  **一歩踏み込んで提案・クロージングまで行う能動的セールスAI**
- パートナー（心理学 × 営業の専門家）が、
  **各クライアントごとにトークスクリプト / 会話フローを Notion 上でチューニング**

詳細なアーキテクチャや API 仕様は、すべて `docs/` 配下のドキュメントに記載しています。

---

## 📚 ドキュメント一覧（詳細はそれぞれ参照）

### アーキテクチャ / 全体像
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
  - システム全体構成（クライアント〜API〜RAG〜LLM〜Billing〜Monitoring）
  - LangGraph / CrewAI 連携を見据えた Orchestrator 構成

### API 仕様
- [`docs/api-agent.md`](docs/api-agent.md)
  - `/agent.search`：RAG ベースの FAQ / セールス回答 API
- [`docs/api-admin.md`](docs/api-admin.md)
  - `/admin/faqs`：FAQ CRUD + Elasticsearch 更新 + Embedding 更新 API
  - Admin UI（React + Supabase Auth）との連携仕様

### 検索 / RAG パイプライン
- [`docs/search-pipeline.md`](docs/search-pipeline.md)
  - Elasticsearch（BM25） + pgvector（cosine / HNSW）のハイブリッド検索
  - TopK マージ手順 / Cross-encoder 再ランク / RAG コンテキスト構築

### DB スキーマ
- [`docs/db-schema.md`](docs/db-schema.md)
  - `faq_docs` / `faq_embeddings` / 将来の `faq_usage` などのテーブル定義
  - テナント分離・インデックス設計・パフォーマンスの方針

### 認証 / テナント管理
- [`docs/auth.md`](docs/auth.md)
  - Supabase Auth を用いた Admin ログイン / JWT 連携
- [`docs/tenant.md`](docs/tenant.md)
  - テナントIDベースのデータ分離・RAG・APIルーティング方針

### その他（HQ 運用系）
- [`REQUIREMENTS.md`](REQUIREMENTS.md)  
  追加要件・グローバル展開・モデル構成・価格設計メモ
- [`AGENTS.md`](AGENTS.md)  
  AI エージェント（Claude / Copilot / ほか）にこのリポジトリを操作させるときのガイド
- [`README_PROJECT.md`](README_PROJECT.md)  
  GitHub Projects を使う場合の運用メモ（現在は Issues/Labels が中心）
- [`team-members.md`](team-members.md)  
  メンバー一覧 / GitHub ID 対応表

> 👆 **仕様・設計・API の詳細は、上記の各ドキュメントを参照してください。**  
> README ではあえて詳細を書かず、「どこに何があるか」だけを示します。

---

## 🧭 タスク管理（ざっくり）

開発タスクは **GitHub Issues + Labels** で管理します。

- ラベル種別（例）
  - `status:*` → `todo` / `in-progress` / `review` / `qa` / `done`
  - `prio:*` → `high` / `medium` / `low`
  - `type:*` → `feat` / `bug` / `chore` / `ops`
  - `phase:*` → `db` / `api` / `ui` / `billing` / `monitoring` / `ci` / `agent`
- よく使うコマンドやフローの詳細は、今後 `docs/` 配下に分離予定

---

## 🔍 Phase / Roadmap（概要）


フェーズの詳細なスコープや完了条件は、`docs/` 配下で管理します。  
README では、現在地点だけをざっくり共有します。

### Phase12 — Planner軽量化 / Fast-path / p95計測

Phase12 では `/agent.dialog` の Planner 軽量化と p95 計測ループを整備しています。詳細は以下のドキュメントを参照してください。

- `docs/PHASE12_SUMMARY.md`
- `docs/PLANNER_RULE_BASED.md`
- `docs/FAST_PATH_LOGIC.md`
- `docs/LOGGING_SCHEMA.md`
- `docs/P95_METRICS.md`

### Phase22 — Failure-Safe Conversational Control（完了 2026-01-13）

Phase22 では、会話型セールスフローと外部アヴァターを対象に、失敗・停止・非利用を前提とした安全な制御状態を確立しました。

- **マルチターン制御**: 状態遷移（clarify → answer → confirm → terminal）、ループ検出、予算制限
- **外部アヴァター制御**: PII検出、Feature Flag、Kill Switch
- **運用・可観測性**: 11種類のログイベント（flow × 4、avatar × 7）

詳細: [`PHASE22.md`](./PHASE22.md), [`docs/PHASE22_IMPLEMENTATION.md`](./docs/PHASE22_IMPLEMENTATION.md)

### Phase23 — KPI & SLA Definitions（完了 2026-01-13）

Phase23 では、Phase22 で確立した制御可能性を基盤に、本番運用レベルの KPI・SLA 定義と計測手順を標準化しました。

- **MVP KPI セット**: 会話完了率、ループ検出率、アヴァターフォールバック率、検索レイテンシ、エラー率、Kill Switch発動回数
- **SLA ゲート**: CI/CD（RPS≥5000, P90≤15ms）、本番（P95≤1500ms, Error<1%）
- **運用キャデンス**: 日次5分チェック、週次レビュー、インシデント対応フロー
- **計測スクリプト**: 7つのKPI計測コマンド（既存ログ活用）

詳細: [`docs/PHASE23.md`](./docs/PHASE23.md)

### Phase10 → Phase11 ブリッジメモ（実装リポジトリ向け）

**Phase10（完了） — Agent HTTP / E2E テスト整備**

実装リポジトリ側で、以下を完了済み：

- `/agent.dialog` HTTP ハンドラの整備
  - `sessionId` の発行・再利用ロジックの安定化
  - multi-step planner 有効時のレスポンス仕様（`answer: null` ＋ `needsClarification: true`）をテストと揃える
- 認証まわりの整理
  - API キー: `x-api-key` ヘッダでの認証を利用
  - Basic 認証: `demo:pass123` でのデモ用クレデンシャルを確認（ローカル）
- E2E テスト `/agent.dialog`（Phase10 でグリーン）
  - `basic dialog returns answer and steps`
  - `dialog reuses sessionId across turns`
  - `dialog returns clarify when multi-step enabled`

**Phase11（これから） — LangGraph / CrewGraph 連携と拡張**

Phase11 では、Phase10 で安定化した `/agent.dialog` を土台に、以下を進める：

- LangGraph / CrewGraph ベースの Orchestrator への移行・統合
  - 既存の `langGraphOrchestrator` / `CrewOrchestrator` 実装を、Phase10 の HTTP レイヤに自然に差し込む
  - `meta.graphVersion` や `meta.multiStepPlan` など、Phase10 時点で追加済みのメタ情報を LangGraph 側でそのまま利用
- Planner/Orchestrator の観測性強化
  - Clarify / Search / Answer ステップごとのメトリクス・ログ項目を追加
  - Phase10 のテストケースをベースに、Phase11 のフロー変更に対するリグレッションテストを追加
- 将来 Phase（12 以降）に向けた A/B / ベイズ最適化のハブとして `/agent.dialog` を位置づけ

👉 詳細なタスク分解や完了条件は、Phase11 用の Issues / Projects 側で管理する（この README では概要のみ）。

- Phase0–2: DB / RAG / Hybrid Search 基盤 → **完了**
- Phase3–4: Multi-step Orchestrator + `/agent.*` API → **完了**
- Phase5: Admin UI（Supabase Auth + FAQ CRUD + ES/Embedding 同期） → **完了**
- Phase6–7: Billing / Monitoring → **着手中**
- Phase8 以降: LangGraph / CrewAI への移行、A/B テスト & ベイズ最適化 → **次フェーズ**

フェーズごとの詳細仕様・テスト方針・k6/Perf Gate 条件などは、順次 `docs/` に追い出していきます。

---

## 🧪 実装側リポジトリとの関係

- このリポジトリ: **HQ（設計・仕様・運用・タスク）**
- 実装リポジトリ（別 repo）: **API / Worker / Frontend 実装**

実装側リポジトリからこの HQ にリンクし、
- どの Phase のタスクなのか
- どのドキュメント（設計）を参照しているか
を常に紐づけておく運用を想定しています。

---

## 📝 更新履歴

- **2025-11-24**: README をシンプル化し、詳細は `docs/` へ集約する方針に変更