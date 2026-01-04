# AGENTS.md — Minimal Issue-Only Workflow (No Projects)

## Sales AaaS対応（2025-11 更新）
- 本リポジトリは FAQ だけでなく HP/LP/キャンペーン情報を扱う Sales AaaS を前提に拡張。
- RAGソースは Notion/CSV/API/HPクロール を含み、テンプレチューニングは Partner が担当。
- モデルは Groq GPT‑OSS 20B/120B（Compound）で Web検索統合。
- すべての Issue/PR 運用ルールは従来通り（Projects 不使用）。

このリポジトリは **Issues + Labels + PRの自動クローズ** だけで運用します。GitHub Projects 連携や Action に依存しません。

---
## 10. Phase11 — Dialog Runtime / Crew Orchestrator / Planner 軽量化フック

Phase11 では、Phase4 で導入した Orchestrator 群に対して「実行経路の安定化」と「パフォーマンス計測」の役割を明確にした。

### ● AgentDialogOrchestrator
- `/agent.dialog` 専用のアプリケーション層 Orchestrator
- HTTP Request/Response に依存せず、`DialogTurnInput → DialogAgentResponse` を構築
- CrewOrchestrator / LangGraphOrchestrator に対する単一の呼び出し窓口
- ログ: `agent.dialog.orchestrator.response` として `route / graphVersion / needsClarification / hasPlannerPlan / hasKpiFunnel / kpiFunnelStage` を出力

### ● Crew Orchestrator / CrewGraph
- Input / Planner / Kpi / Final ノードを制御する CrewGraph の実行を担当
- PlannerNode を LangGraph runtime 呼び出しに限定し、CrewGraph と LangGraph の責務境界を明確化
- テスト: `test:agent:crew:once` で linear flow を保証

### ● Rule-based Planner（Skeleton）
- `buildRuleBasedPlan(input, intent)` を通じて、shipping / returns / payment / product-info などの典型 FAQ を将来的にルールベースで扱うためのフック
- Phase11 時点では常に `null` を返し、挙動は LLM Planner にフォールバックさせる
- 今後、Planner Agent の負荷軽減・p95 改善のために実装を追加予定

### ● Metrics / Perf Agent（ログ解析ツール）
- `SCRIPTS/analyze-agent-logs.ts` により、pino ログから次のレイテンシ指標を集計:
  - RAG: `dialog.rag.finished.totalMs`
  - Planner: `tag="planner".latencyMs`
  - Answer: `dialog.answer.finished.latencyMs`
- 役割:
  - RAG / Planner / Answer のどこがボトルネックかを可視化
  - 「Planner をどこまで Rule-based に寄せるか」の意思決定材料を提供
## Label Scheme
- **status:** `status:todo`, `status:in-progress`, `status:review`, `status:qa`, `status:done`
- **prio:** `prio:high`, `prio:medium`, `prio:low`
- **type:** `type:feat`, `type:bug`, `type:chore`, `type:ops`
- **phase:** `phase:db`, `phase:api`, `phase:ui`, `phase:billing`, `phase:monitoring`, `phase:ci`

> 状態遷移は **ステータス系ラベルの付け替え** で行います（Projectsのカラム移動の代替）。

---
## 起票（Issue Create）
```bash
# 自分にアサイン、初期ステータスは TODO
ISSUE_TITLE="RAGハイブリッド検索のパフォーマンス最適化"
ISSUE_BODY=$'目的: p95 ≤1.5s維持のためにRAG再ランクを軽量化。\n対象: pgvector + Elasticsearch 統合。\n完了条件: latency<1.5s, TopK=50, Cross-encoder稼働確認。'

gh issue create -R milechy/commerce-faq-tasks \
  --title "$ISSUE_TITLE" \
  --body "$ISSUE_BODY" \
  --label "type:feat,status:todo,prio:high,phase:api" \
  --assignee "@me"

ステータス変更（ラベル付け替え）
# TODO -> IN PROGRESS
NUM=4  # 対象Issue番号

gh issue edit $NUM -R milechy/commerce-faq-tasks \
  --add-label "status:in-progress" \
  --remove-label "status:todo"

# IN PROGRESS -> REVIEW
gh issue edit $NUM -R milechy/commerce-faq-tasks \
  --add-label "status:review" \
  --remove-label "status:in-progress"

# REVIEW -> QA / DONE も同様

ブランチ & PR（Issueと結びつける）
# ブランチ命名: <type>/<short-slug>-<issue#>
NUM=4
BR="feat/rag-hybrid-perf-$NUM"

git checkout -b "$BR"
# ... commit 作業 ...

git push -u origin "$BR"

gh pr create -R milechy/commerce-faq-tasks \
  -B main -H "$BR" \
  -t "RAG: hybrid search perf (Closes #$NUM)" \
  -b $'実装詳細...\n\nCloses #'"$NUM"

Closes #<num> を PR本文 に含めると、マージ時に Issue が自動 Close されます。

よく使うスニペット
# 新規タスク（テンプレ関数）
new_task(){
  local title="$1"; shift
  local body="$*"
  gh issue create -R milechy/commerce-faq-tasks \
    --title "$title" \
    --body "$body" \
    --label "status:todo" --label "prio:medium" --label "type:feat" --label "phase:api" \
    --assignee "@me"
}

# 状態を一発で切り替える: set_status <num> <todo|in-progress|review|qa|done>
set_status(){
  local n=$1; local s=$2
  gh issue edit "$n" -R milechy/commerce-faq-tasks \
    --add-label "status:$s" \
    --remove-label "status:todo" \
    --remove-label "status:in-progress" \
    --remove-label "status:review" \
    --remove-label "status:qa" \
    --remove-label "status:done"
}

運用ポリシー（最小）

すべての作業は Issue 起票 から開始（口頭/Slackはリンクを本文に貼る）。
進捗はラベル status:* で管理。Projects は使用しない。
PR は 必ずCloses #<番号> を本文に記載。
マージ後、必要に応じて status:qa → status:done に更新。

付録（メンテ）

Projects連動用のActionは削除済み。復活させる場合は別ブランチで検証→PR。
ラベルは gh label list -R milechy/commerce-faq-tasks で確認／追加可能。


---
---

## 9. Phase4 — Agent Orchestrator Roles（LangGraph / Planner / Safety）

※Sales AaaSでは、Planner/Search に "promo", "campaign", "coupon", "product-intent" を追加識別。

本フェーズで追加された **Orchestrator（対話制御）系エージェントの役割定義**を以下にまとめる。

### ● Dialog Orchestrator（LangGraph）
- `/agent.dialog` のメイン制御フローを担当
- 各ノード（ContextBuilder / Planner / Search / Answer）を統合
- history summary によるロング対話の圧縮
- multi-step plan（clarify / follow‑up / search）の分岐
- safety 情報（safetyTag / requiresSafeMode）を収集し、LLM ルートを決定

### ● Planner Agent（Groq 20B/120B）
- Clarify / Follow-up / Search ステップの生成
- 複雑度・曖昧度の解析 → 20B/120B の昇格判断補助
- safety キーワード検出（暴力/自傷/法務/規制/安全）
- “fast-path skip” 不要判定のための軽量解析

### ● Safety Agent（軽量ルール + LLM）
- ユーザー入力の即時スキャン（暴力/虐待/自殺/法的リスク）
- safe-zone 判定 → requiresSafeMode=true の設定
- 120B を強制ルート（安全性優先）
- Answer のトーン（慎重/中立）を切り替える

### ● Search Agent（Phase3 RAG統合）
- Planner で決定された search ステップを実行
- Elasticsearch（BM25）+ pgvector（semantic）ハイブリッド検索
- Cross‑encoder による再ランク（Top‑80 → Top‑5）
- notes / scores / recall 情報を Orchestrator に返却

### ● Answer Agent（Groq 20B/120B）
- RAG＋Planner＋Safety結果を統合した最終回答
- 言語別テンプレ（ja/en）を使用
- safety モードでは慎重な表現・注意喚起を付与
- maxTokens を制御し、p95低減（20B=256, 120B=320）

### ● Route Planner（20B → 120B）
- route ∈ {20b,120b}
- plannerReasons を付加（base-rule, complexity, safety, history-depth）
- fallback（Planner失敗 → Phase3 local agent）も統合的に処理