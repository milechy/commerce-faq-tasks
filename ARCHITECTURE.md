# 改善後アーキテクチャ（要点）

```mermaid
graph TD
A[Client Widget] -->|HTTPS| B[API Gateway]
B --> C[RAG Retriever]
C --> C1[pgvector (Hetzner)] & C2[Elasticsearch (Hetzner)]
C --> C3[Cross-encoder Re-ranker]
B --> D[Groq Cloud (GPT‑OSS 20B/120B)]
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
	1.	(Hetzner) ES Top-50 と (Hetzner) pgvector Top-50 を並列
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

Sales AaaS拡張: HP/LP/キャンペーン/クーポン/商品DBを統合し、RAG+Web検索で誘導最適化

## Phase13: Notion-driven Sales AaaS（Clarify / Templates / Logs）

Phase13 では、上記アーキテクチャに対して次のコンポーネントを追加する。

- Notion Client / Notion Sync Service
  - Notion DB（FAQ / Products / LP Points / TuningTemplates / Clarify Log）からデータを取得
  - `SCRIPTS/sync-notion.ts` 経由で FAQ / Products / LP Points / TuningTemplates を Postgres に同期
- TuningTemplates（Sales Templates & Tone）
  - Tuning DB ノード `T` の実体として、Notion から同期されたテンプレ＋トーン設定を保持
  - SalesTemplateProvider がメモリ上でテンプレをキャッシュし、Clarify / Propose / Recommend / Close の各フェーズで利用
- Clarify Log Writer
  - `/integrations/notion/clarify-log` エンドポイントから呼ばれ、Clarify 実行結果を Notion Clarify Log DB に書き戻す
  - Dialog Runtime 本体とは疎結合に保ち、書き戻し失敗時もユーザ応答フローは継続する設計とする

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

## Sales AaaS対応（2025-11 更新）
- 本リポジトリは FAQ だけでなく HP/LP/キャンペーン情報を扱う Sales AaaS を前提に拡張。
- RAGソースは Notion/CSV/API/HPクロール を含み、テンプレチューニングは Partner が担当。
- モデルは Groq GPT‑OSS 20B/120B（Compound）で Web検索統合。
- すべての Issue/PR 運用ルールは従来通り（Projects 不使用）。

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

# Phase4: Agent Orchestrator 拡張まとめ

※Sales AaaSでは、Planner/Search に "promo", "campaign", "coupon", "product-intent" を追加識別。

## LangGraph Orchestrator（Planner / Clarify / Search / Sales / Answer / Final）

 - `/agent.dialog` の主要処理は LangGraph ベースの Orchestrator に移行  
 - 各ノード:
   - **contextBuilderNode**: RAG & history summary（ロング対話の圧縮）
   - **plannerNode**: Groq 20B/120B を用いた Clarify / Follow-up / Search / Sales ステップ計画
   - **clarifyNode**: 不足情報のヒアリング（Clarify 質問生成）
   - **searchNode**: Phase3 RAG（ES + pgvector + Cross-encoder）と完全統合
   - **salesNode**: PlannerPlan（SalesStage）とテキストから Upsell / CTA を判定し、`salesMeta` を構築
   - **answerNode**: Answer LLM による最終回答生成（トーン/スタイル制御）
   - **finalNode**: UI 向けレスポンス整形（steps/salesMeta/graphVersion をまとめて返却）

## /agent.dialog レスポンス拡張（Phase8: LangGraph + SalesMeta）

- LangGraph Orchestrator 経由の応答では、従来の `answer` に加えて以下のメタ情報を返却：
  - `steps[]`: Planner が生成した SalesStage 列（`clarify / propose / recommend / close`）
  - `meta.plannerPlan`: PlannerPlan 全体（steps / clarifyingQuestions / confidence）
  - `meta.salesMeta`: セールス文脈メタ（`upsellTriggered / ctaTriggered / notes[]`）
  - `meta.graphVersion`: 現在は `"langgraph-v1"` 固定（将来のバージョニング用）

```jsonc
{
  "answer": "...",
  "steps": [
    { "id": "step_clarify_1", "stage": "clarify", "title": "用途のヒアリング", ... },
    { "id": "step_recommend_1", "stage": "recommend", "title": "おすすめプランの提示", ... },
    { "id": "step_close_1", "stage": "close", "cta": "purchase", ... }
  ],
  "meta": {
    "route": "20b",
    "plannerPlan": { "steps": [...], "needsClarification": true },
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

```
## 新ルーティング（20B/120B） + Safety 強化

### routePlannerModelV2 の導入
- `route ∈ {20b,120b}`
- `requiresSafeMode` フラグ追加（legal / security / policy / violence など）
- safety あり → **必ず 120B** へ昇格
- safety なし → 基本は 20B

### Answer 出力
- セーフティ時はより慎重なトーンとガイダンスへ最適化
- maxTokens を調整（20B=256, 120B=320）
```

```
## Fast-path（Planner スキップ）

2ターン目以降で以下を満たす場合、Planner を省略して即 Answer へ遷移：

- history.length > 0  
- intent ∈ {shipping, returns, payment, product-info}  
- テキスト長 ≥ 15  
- safety 無し  

結果として 2ターン目の p50 は **1.5〜1.8s** まで短縮。
```

```
## 長期履歴の圧縮（Summary Node）

- history が長い場合、自動で summary を生成
- summary + 直近数ターンのみを Planner/Answer に渡す
- context_tokens の暴走を防ぎ、120B の無駄な昇格を抑制
```

```
## p95 / RPS パフォーマンス

- 1ターン目（Clarify 必要）: 1.7〜2.7s  
- 2ターン目 fast-path: 1.3〜1.8s  
- safety モード（120B）: 2.7〜4.0s  
- fallback(local) 時は 3.0〜3.8s  

p50 が 1.7s、p95 は fallback/混雑時で 3.6s 程度。
```

```
## ログ統合（pino）

- route / plannerReasons / safetyTag / requiresSafeMode / durationMs を `/agent.dialog` で一元ログ化
- Datadog/Otel でも集計しやすい構造へ統一

## Phase11: Dialog Runtime Hardening（CrewGraph + LangGraph）

Phase11 では、これまで Phase4/8 で導入した LangGraph Orchestrator をベースに、実行経路とログ構造を本番運用前提で固めた。

### Orchestrator レイヤの分離
- `/agent.dialog`:
  - HTTP ハンドラ → **AgentDialogOrchestrator** → **CrewOrchestrator** → **LangGraphOrchestrator** というレイヤ構造に整理
  - HTTP 依存のない `AgentDialogOrchestrator.run()` が `DialogTurnInput → DialogAgentResponse` を組み立てる単一の入口となる
- CrewGraph:
  - Input / Planner / Kpi / Final のノード構成を固定し、PlannerNode は LangGraph runtime をラップする役割に限定
  - `CrewGraph.test.ts` / `langGraphOrchestrator.test.ts` により、CrewGraph と LangGraph の pipeline 一致を検証

### Planner 軽量化フック（Rule-based Planner）
- `plannerNode` 内に Rule-based Planner (`buildRuleBasedPlan(input, intent)`) を差し込むフックを追加
- Phase11 時点では常に `null` を返すスケルトンとし、挙動は従来通り LLM Planner を経由
- 将来、shipping / returns / payment / product-info などの典型 FAQ はここで PlannerPlan を構築し、LLM Planner の呼び出し頻度を削減する前提

### Dialog Runtime ログ（p95 計測基盤）
- pino ログで `/agent.dialog` の 1ターンごとに以下を記録:
  - `dialog.rag.finished`: `totalMs`, `searchMs`, `rerankMs`
  - `tag: "planner"`: Planner LLM の `latencyMs`
  - `dialog.answer.finished`: Answer LLM の `latencyMs`
  - `agent.dialog.orchestrator.response`: `route`, `graphVersion`, `needsClarification`, `final`, `hasPlannerPlan`, `hasKpiFunnel`, `kpiFunnelStage`
- `SCRIPTS/analyze-agent-logs.ts` により、これらログから RAG / Planner / Answer の p50 / p95 をオフライン集計可能とし、p95 ≤ 1.5s の要件を検証しやすくした。
```

```
## 今後の拡張ポイント（Phase5 以降）

- Search Agent の非同期化 / prefetch  
- Planner の軽量化（20B→8B 相当モデルへの差し替え）  
- Summarizer の再最適化（context budget 1200〜1600 tokens へ）  
- RAG の Top-K 動的最適化（高速クエリは bm25 先行）  
- 120B への昇格率 < 10% を堅持  
```