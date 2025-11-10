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

## 10. `REQUIREMENTS.md`
```markdown
# 要件サマリ（v2025-10-R3）

## 非機能
- レイテンシ: p95 ≤ 1.5s（Cloudflare + regional endpoint）
- 可用性: 99.9% （Multi-region）
- 拡張性: 100 tenants+
- コスト: $<0.001/req を目安（20B優先・キャッシュ再利用）
- 監査性: 全ログ署名・改ざん不可保存

## アーキ概要
- Frontend: Next.js/React Widget
- Backend: FastAPI（Node可） / API Gateway
- LLM: Groq GPT-OSS 20B/120B（昇格・フォールバック）
- RAG: PostgreSQL + pgvector（+ Chroma optional）× Elasticsearch（BM25）
- 再ランク: Cross-encoder（軽量）
- DB: PostgreSQL 16 + RLS
- Cache: Redis（prompt cache + rate limit）
- Infra: Cloudflare WAF/CDN/ZeroTrust + GCP/AWS Compute
- Orchestration: n8n + CrewAI
- DevOps: GitHub Actions + CodeRabbit
- QA/E2E: Tester-H（staging）/ k6
- Observability: Datadog + OpenTelemetry
- Billing: Stripe（従量）+ SendGrid通知 + Webhook

## 主要機能差分（R3）
- ルーティング最適化（20B既定、複雑時120Bへ）
- RAGハイブリッド強化（Top-50×2→Top-80→再ランクTop-5）
- A/Bテスト（tone×CTA）管理UI
- 多言語（ja/en）v1.0でリリース
- コストモデル：トークン実測×係数（1.5/2.5）Notionに反映

## 多言語
- LangID → ja/en プロンプト切替
- 禁則辞書・テンプレを言語別管理
- 評価セット：`eval_ja`, `eval_en`

## Billing（要点）
- 実コスト（最小通貨整数）× Margin Rate → Invoice
- Stripe UsageRecord（1円=1unit）冪等キー：`billing:{tenant}:{yyyymm}`
- Webhook成功でNotionにInvoice URL/Status反映

## 監視/KPI
- p95/p99, 成功率, tokens_in/out, CTR, 再購率, 粗利率, 根拠提示率
- アラート例：p95>1.8s(5分), 120B比率>15%, Error>1%