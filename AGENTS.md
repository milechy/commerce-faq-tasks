# AGENTS.md — Minimal Issue-Only Workflow (No Projects)

このリポジトリは **Issues + Labels + PRの自動クローズ** だけで運用します。GitHub Projects 連携や Action に依存しません。

---
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
```

---
## ステータス変更（ラベル付け替え）
```bash
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
```

---
## ブランチ & PR（Issueと結びつける）
```bash
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
```
> `Closes #<num>` を **PR本文** に含めると、マージ時に Issue が自動 Close されます。

---
## よく使うスニペット
```bash
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
```

---
## 運用ポリシー（最小）
1. すべての作業は **Issue 起票** から開始（口頭/Slackはリンクを本文に貼る）。
2. 進捗はラベル `status:*` で管理。Projects は使用しない。
3. PR は **必ず** `Closes #<番号>` を本文に記載。
4. マージ後、必要に応じて `status:qa → status:done` に更新。

---
## 付録（メンテ）
- Projects連動用のActionは削除済み。復活させる場合は別ブランチで検証→PR。
- ラベルは `gh label list -R milechy/commerce-faq-tasks` で確認／追加可能。# 改善後アーキテクチャ（要点）

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