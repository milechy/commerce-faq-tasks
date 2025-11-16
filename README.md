# Commerce-FAQ SaaS — 開発HQ / タスク管理リポジトリ

このリポジトリは **プロダクト実装コードではなく**、AI FAQサービス *Commerce-FAQ SaaS* の「開発HQ（Docs・ワークフロー・タスク運用）」をまとめるためのリポジトリです。GitHub Issues/Labels/PR を中心に、Notionで定義した各種アーキテクチャ/Runbookを開発の実務に落とし込みます。

---
## 目的
- タスク管理：GitHub Issues + Labels（`status/prio/type/phase`）で軽量運用
- ドキュメント集約：アーキ・運用・価格/Billing・オンボーディングをここにリンク
- 自動化：`SCRIPTS/` のスクリプトでラベル/起票フローを最短化

---
## プロダクト要約（再掲）
- サービス名: **Commerce-FAQ SaaS**
- 目的: AI FAQ + 販促誘導 + 従量課金（固定費ゼロ）
- モデル: Groq GPT-OSS 20B/120B（自動ルーティング）
- 構成: Widget / API / RAG(DB: PostgreSQL+pgvector) / Billing(Stripe) / SendGrid / Datadog & Sentry
- 料金: **従量オンリー**（スタンダード×1.5 / カスタム×2.5、初月無料）

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