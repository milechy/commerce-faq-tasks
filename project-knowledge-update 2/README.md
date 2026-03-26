# RAJIUCE — AI Sales Assistant SaaS

**Commerce-FAQ SaaS / Commerce-AaaS（Sales Assistant as a Service）**
AIによるFAQ応答・セールス誘導・アバター接客を提供するマルチテナントSaaSプラットフォーム。

> このリポジトリはHQ兼実装リポジトリです。API・Admin UI・Widget・RAGパイプラインの実装コードをすべて含みます。

---

## プロダクト概要

- **サービス**: HP / LP / FAQ を横断し、顧客の目的達成（購入・予約・問い合わせ）を能動的に支援するAIセールスパートナー
- **コア機能**: FAQ応答 + 商品レコメンド + キャンペーン案内 + アバター接客 + チューニングルール
- **モデル**: Groq 20B（default）/ 120B（complex/safety、比率≤10%）
- **RAG**: pgvector + Elasticsearch → Cross-encoder rerank → Top-5
- **インフラ**: Hetzner VPS (65.108.159.161) + Supabase Auth + Stripe Billing

---

## 技術スタック

| レイヤ | 技術 |
|--------|------|
| API Server | Express + TypeScript (`src/index.ts`) |
| Widget | Vanilla JS + Shadow DOM (`public/widget.js`) |
| Admin UI | React + Vite + Supabase Auth (`admin-ui/`) |
| Avatar | Python + LiveKit + Lemonslice + Fish Audio TTS (`avatar-agent/`) |
| RAG | pgvector (Hetzner) + Elasticsearch (Hetzner) + Cross-encoder |
| LLM | Groq 20B / 120B |
| Auth | Supabase JWT + x-api-key (ハッシュ) |
| Billing | Stripe metered billing |
| Monitoring | Prometheus + Grafana + Slack AlertEngine |
| Deploy | PM2 + `bash SCRIPTS/deploy-vps.sh` |

---

## アーキテクチャ

詳細: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

```
Widget (1行埋め込み)
  └─ POST /api/chat (x-api-key)
       └─ 4層セキュリティ: rateLimiter → auth → tenantContext → securityPolicy
            └─ Dialog Flow SM: clarify → answer → confirm → terminal
                 └─ RAG: ES(BM25) + PG(vector) → Cross-encoder → Groq 20B/120B

Admin UI (React SPA)
  └─ Bearer JWT (Supabase)
       └─ /v1/admin/* (テナント管理・FAQ・会話履歴・チューニング・アバター)

Avatar Agent (Python)
  └─ LiveKit Room + Lemonslice AvatarSession + Fish Audio TTS + Groq LLM
```

---

## セキュリティ

4層Widgetセキュリティ（Security L1-L4、2026-03-24完了）:

| Level | 内容 |
|-------|------|
| L1 | Widget JS難読化（`SCRIPTS/build-widget-obfuscated.sh`） |
| L2 | SourceMap無効化 + console.log除去 |
| L3 | APIキードメインバインド（`api_keys.allowed_origins`） |
| L4 | 動的Widget配信（`GET /widget.js?key=<apiKey>`でテナント個別JS生成） |

スキャン: `bash SCRIPTS/security-scan.sh`（デプロイ前必須）
ポリシー: [`docs/SECURITY_SCAN_POLICY.md`](docs/SECURITY_SCAN_POLICY.md)

---

## MVP Roadmap（Phase進捗）

| Phase | 内容 | Status |
|-------|------|--------|
| Phase18 | UI / CE Integration | ✅ Completed |
| Phase22 | Failure-Safe Conversational Control | ✅ Completed (2026-01-13) |
| Phase23 | KPI & SLA Definitions | ✅ Completed (2026-01-13) |
| Phase28 | VPS本番デプロイ（Hetzner） | ✅ Completed (2026-03-05) |
| Phase30-31 | Admin UI + テナント管理API | ✅ Completed (2026-03-14) |
| Phase32 | Billing Pipeline (Stripe) | ✅ Completed (2026-03-16) |
| Phase36 | 認証フロー修正 + Admin UI品質向上 | ✅ Completed (2026-03-17) |
| Phase38 | 会話履歴 + チューニングルール | ✅ Completed (2026-03-24) |
| Phase39 | UI品質向上（Mobile First） | ✅ Completed (2026-03-19) |
| Phase40 | Lemonslice Avatar統合 | ✅ Completed (2026-03-20) |
| Phase41 | Avatar Customization Studio | ✅ Completed (2026-03-23) |
| Phase42 | Anam.ai移行 | ❌ Cancelled (2026-03-22) |
| Security L1-L4 | Widget セキュリティ強化 | ✅ Completed (2026-03-24) |
| Phase43 | フィードバック管理 + Admin AIチャットナビ | ✅ Completed (2026-03-24) |
| Phase44 | デフォルトアバター管理 | ✅ Completed (2026-03-24) |

**現在地: Phase44完了。全主要機能が本番稼働中。**

---

## 主要ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [`CLAUDE.md`](CLAUDE.md) | Claude Code向け開発ルール・アーキテクチャサマリー |
| [`PHASE_ROADMAP.md`](PHASE_ROADMAP.md) | 各Phaseの詳細と完了状態 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | システム全体像（Mermaid図） |
| [`VPS_OPS_GUIDE.md`](VPS_OPS_GUIDE.md) | VPS運用・デプロイ・PM2管理 |
| [`docs/DEPLOY_CHECKLIST.md`](docs/DEPLOY_CHECKLIST.md) | デプロイ前チェックリスト |
| [`docs/SECURITY_SCAN_POLICY.md`](docs/SECURITY_SCAN_POLICY.md) | セキュリティスキャンポリシー |
| [`docs/PHASE38_COMPLETION.md`](docs/PHASE38_COMPLETION.md) | Phase38詳細（会話履歴・チューニング） |
| [`avatar-agent/README.md`](avatar-agent/README.md) | Avatarエージェント構成 |

---

## デプロイ

```bash
# 唯一のデプロイコマンド（rsync + build + PM2 restart）
bash SCRIPTS/deploy-vps.sh

# デプロイ前セキュリティスキャン（推奨）
bash SCRIPTS/security-scan.sh
```

VPS: `65.108.159.161`
API: `http://65.108.159.161:3100/health`
Admin UI: `http://65.108.159.161:5173/`

---

## Definition of Done

```
pnpm typecheck → 0 errors
pnpm lint      → 0 warnings
pnpm test      → all pass
pnpm test:e2e  → mobile viewport passes (390px)
Codex Gate     → P0/P1 none
```

---

## claude-peers MCP

複数のClaude Codeインスタンス間でメッセージを共有するMCPサーバーを使用中。
並列実装タスク（multi-agent実装）でインスタンス間の調整に活用。

---

## コスト制約

- 月額: $27-48
- Groq API: usage-based（120B比率 ≤10%）
- Grafana + Prometheus: self-hosted $0-5

---

*最終更新: 2026-03-25*
