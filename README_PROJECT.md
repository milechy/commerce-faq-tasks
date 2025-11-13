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