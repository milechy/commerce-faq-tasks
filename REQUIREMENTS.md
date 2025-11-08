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