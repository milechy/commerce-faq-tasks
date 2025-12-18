# 要件サマリ（v2025-10-R3）

## 非機能
- レイテンシ: p95 ≤ 1.5s（Cloudflare + regional endpoint）
- 可用性: 99.9% （Multi-region）
- 拡張性: 100 tenants+
- コスト: $<0.001/req（Groq 20B優先・pgvector/ESローカルでの高速再利用）
- 監査性: 全ログ署名・改ざん不可保存

## アーキ概要
- Frontend: Next.js/React Widget
- Backend: FastAPI（Node可） / API Gateway
- LLM: Groq GPT-OSS 20B/120B（昇格・フォールバック）
- RAG: PostgreSQL + pgvector（Hetzner）× Elasticsearch（Hetzner, BM25）
- 再ランク: Cross-encoder（軽量）
- DB: PostgreSQL 16 + RLS
- Cache: Redis（prompt cache + rate limit）
- Infra: Cloudflare WAF/CDN/ZeroTrust + Hetzner Dedicated (DB/ES/Orchestrator)
- Orchestration: n8n + CrewAI
- DevOps: GitHub Actions + CodeRabbit
- QA/E2E: Tester-H（staging）/ k6
- Observability: Datadog + OpenTelemetry
- Billing: Stripe（従量）+ n8n通知 + Webhook


## 主要機能差分（R3）
- ルーティング最適化（20B既定、複雑時120Bへ）
- RAGハイブリッド強化（Top-50×2→Top-80→再ランクTop-5）
- A/Bテスト（tone×CTA）管理UI
- 多言語（ja/en）v1.0でリリース
- コストモデル：トークン実測×係数（1.5/2.5）Notionに反映

## Phase13: Notion-driven Sales AaaS 要件

- Notion をコンテンツの Single Source of Truth として利用すること
  - FAQ / Products / LP Points / TuningTemplates / Clarify Log を Notion DB で管理
  - テンプレ文言の更新は Partner 側が Notion 上で行い、アプリ側は同期のみを担当
- Notion Sync
  - `pnpm sync:notion` により FAQ / Products / LP Points / TuningTemplates を Postgres に同期できること
  - アプリ起動時には TuningTemplates のみ自動同期し、Sales テンプレ（Clarify など）をメモリにロードすること
  - Notion API 障害時は同期処理のみ失敗とし、本番トラフィックには影響させないこと（ログ＋アラート）
- Sales Templates（Clarify）
  - Clarify / Sales 用の文面テンプレを TuningTemplates DB から取得すること
  - intent / personaTags / phase（Clarify/Propose/Recommend/Close）でテンプレをフィルタできる構造にすること
  - Phase13 では最低限 `Clarify × 英会話 intent (level_diagnosis / goal_setting)` が利用可能であること
- Clarify Log
  - Clarify 発生時に、Notion の Clarify Log DB へ 1 レコード create できること
  - 必須プロパティ: `Original / Clarify / Missing / Intent / TenantId`
  - Clarify Log 書き込みに失敗してもユーザー向けレスポンスは返却されること（fire-and-forget / best-effort）

## 多言語
- LangID → ja/en プロンプト切替
- 禁則辞書・テンプレを言語別管理
- 評価セット：`eval_ja`, `eval_en`

## Billing（要点）
- 実コスト（最小通貨整数）× Margin Rate → Invoice
- Stripe UsageRecord（1円=1unit）冪等キー：`billing:{tenant}:{yyyymm}`
- Webhook成功でNotionにInvoice URL/Status反映

### Billing レイヤーモデル

- Layer1: 従量課金（Usage）
  - `/agent.dialog`, `/agent.search`, HP/LP ナビなどの API 呼び出しを対象とする
  - 1 リクエストごとに tokens_in / tokens_out / model / latency / route / tenantId を計測し、日次で `usage_logs` に集計されること
  - `usage_logs` の `cost_llm`（LLM原価）と `cost_total`（マージン込みコスト）を Stripe 請求のベースとすること
- Layer2: サブスクリプション（ベース料金）
  - テナントごとに「月額基本料金」を Stripe Subscription で管理できること
  - 従量課金が 0 の月でも、ベース料金による請求が継続されること
- Layer3: チューニング・初期セットアップ
  - 初期導入時の RAG 構築・SalesFlow チューニングを別途「一時費用」として請求できること
  - このレイヤーの金額・ステータスは Notion Billing Summary DB にメタ情報として保持されること

### 管理 UI（Billing / Usage）要件（概略）

- 管理 UI には、FAQ 管理とは別に「Billing / Usage」タブが存在すること
- テナントごとに以下を参照できること（少なくとも日次・月次集計）
  - total_requests / dialog_requests / search_requests / hp_sessions
  - cost_llm / cost_total
  - billing_status（pending / billed / error 等）
- Stripe 連携が有効な環境では、Notion または DB に保存された Invoice URL / Customer Portal へのリンクを表示できること