# タスク運用（Issueテンプレ & DoD）

## 起票テンプレ
**タイトル例**: RAGハイブリッド検索のパフォーマンス最適化  
**本文雛形**：
- 目的: p95 ≤1.5s維持のため再ランクを軽量化
- 対象: pgvector + Elasticsearch 統合
- DoD:
  - [ ] latency < 1.5s（APM計測）
  - [ ] TopK=50（ES/pgvector）→再ランクTop-5
  - [ ] Cross-encoder 稼働ログ/回帰テストOK
- リスク/緩和:
  - 再ランク遅延 → Top-K縮小 / 事前要約 / ES最適化

**起票コマンド例**：
```bash
gh issue create -R milechy/commerce-faq-tasks \
  --title "RAGハイブリッド検索のパフォーマンス最適化" \
  --body $'目的: p95 ≤1.5s維持のためにRAG再ランクを軽量化。\n対象: pgvector + Elasticsearch 統合。\n完了条件: latency<1.5s, TopK=50, Cross-encoder稼働確認。' \
  --label "type:feat,status:todo,prio:high,phase:api" \
  --assignee "@me"

ステータス遷移（ラベル）
•	todo → in-progress → review → qa → done
•	コマンド例：AGENTS.md の set_status 関数
代表タスクセット（抜粋）
•	Phase 1: DB/RLS
•	RLS enforce（tenant_id）
•	PII 別スキーマ+AES
•	Phase 2: RAG
•	ES + pgvector 並列検索 / Top-K調整
•	再ランク導入 / 品質回帰
•	Phase 3: Routing
•	複雑度判定器 / flags 出力
•	Phase 4: API/UI
•	Widget LangID / ja・en 切替
•	Phase 6: Billing
•	UsageRecord idempotent 送信 / Stripe差分±0
•	Webhook署名検証 / メール連携
•	Phase 7: Monitoring
•	p95, p99, 120B比率, CTR アラート
•	Phase 8: CI/CD & QA
•	k6: p95<1.5s, error<0.5%
•	Tester-H: E2E合格

---

## 5. `new_task_template.sh`
```bash
#!/usr/bin/env bash
# new_task "<タイトル>" "<本文>"
set -euo pipefail
OWNER="milechy"
REPO="commerce-faq-tasks"

title="${1:?title required}"
body="${2:-}"

gh issue create -R "$OWNER/$REPO" \
  --title "$title" \
  --body "$body" \
  --label "status:todo" --label "prio:medium" --label "type:feat" --label "phase:api" \
  --assignee "@me"