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

---

# 3_TASKS.md
```markdown
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

# 4_AGENT_RULES.md
```markdown
# AGENTルール（GPT/Claude/Copilot用）

## 目的
- Issues/Labels/PRのみで進捗管理。Projects不要。
- PR本文の `Closes #<num>` を厳守。

## 入出力フォーマット
- **出力**は常に「貼って使えるコマンド or 追記パッチ」。
- 曖昧な点は「仮の値」を置き、同時に該当箇所を `TODO:` で明示。

## 推奨ブランチ規約
- `<type>/<slug>-<#>` 例: `feat/rag-hybrid-perf-4`

## よく使うタスク生成（関数）
- `new_task "<タイトル>" "<本文>"` … `5_SCRIPTS/new_task_template.sh`

## セキュリティ/運用ガード
- .env/SecretsはVault管理。平文禁止。
- SQL/RLS: `SET app.current_tenant = :tenant_id` を必ず適用。
- Webhook: 署名検証+即時200+非同期処理。
- 監視: しきい値超過→Slack通知→Runbook起動。

## 品質基準（共通DoD）
- APMで p95 ≤ 1.5s
- 根拠提示率 ≥ 95%
- 120B比率 ≤ 10%
- E2E/k6/Unit 全合格