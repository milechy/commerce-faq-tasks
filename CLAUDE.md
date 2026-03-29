# RAJIUCE CLAUDE.md

## Core Principles
1. **Security First** — Book content never leaves DB. RAG excerpts ≤200 chars. API keys SHA-256 hashed. tenantId from JWT only.
2. **Mobile First** — Touch targets ≥44px. Font ≥16px. Test 390px viewport first.
3. **Partner Friendly** — No jargon. Every error = kind message. Every action = success feedback.

## Definition of Done
- pnpm typecheck → 0 errors
- pnpm lint → 0 warnings
- pnpm test → all pass
- pnpm test:e2e → mobile viewport passes
- Codex Gate → P0/P1 none

## Anti-Slop
- ragExcerpt.slice(0, 200) 必須
- tenantId: JWTまたはAPIキーから取得、bodyから禁止
- console.log(ragContent) 禁止
- 120Bモデル: 複雑クエリ/safety時のみ（比率 ≤10%）
- PII・書籍内容をメトリクスラベル/アラートメッセージに含めない

## Architecture Summary
- Widget: `public/widget.js` — 1行埋め込み、Shadow DOM、data-api-key 認証
- API: `src/index.ts` — Express + 4層セキュリティスタック (rateLimiter → auth → tenantContext → securityPolicy)
- CORS: グローバル適用 (OPTIONS preflight 対応)
- RAG: pgvector + Elasticsearch → Cross-encoder rerank → Groq 20B/120B
- Flow: clarify → answer → confirm → terminal (Phase22 State Machine)
- Sales: clarify → propose → recommend → close (SalesFlow Pipeline)
- Monitoring: Prometheus + Grafana + Slack AlertEngine (Phase24)
- Judge: Gemini 2.5 Flash → 4軸評価 → チューニングルール自動提案 (Phase45)
- Gap: 4トリガー → Gemini推薦エンジン → 知識追加 (Phase46)
- Book RAG: PDF → 6フィールド構造化 → pgvector + ES (Phase47)
- LLM Defense: L5 Input Sanitizer → L6 Prompt Firewall → L7 Topic Guard → L8 Output Guard (Phase48)

## Key Endpoints
| Path | Auth | Purpose |
|---|---|---|
| POST /api/chat | x-api-key | Widget → Chat |
| POST /dialog/turn | x-api-key / JWT | Multi-turn dialog |
| POST /agent.search | x-api-key / JWT | RAG search |
| GET /health | public | ES/PG/CE health |
| GET /metrics | X-Internal-Request: 1 | Prometheus metrics |
| /v1/admin/tenants/* | JWT (super_admin) | テナント管理 |
| /v1/admin/chat-history/* | JWT | 会話履歴 |
| /v1/admin/tuning/* | JWT | チューニングルール |
| /v1/admin/feedback/* | JWT | フィードバック管理 |
| /v1/admin/avatar/* | JWT | アバター設定 (Phase40-41) |
| /v1/admin/evaluations/* | JWT | Judge評価 (Phase45) |
| /v1/admin/knowledge-gaps/* | JWT | Gap検出 (Phase46) |
| /v1/admin/knowledge/books/* | JWT | PDF書籍管理 (Phase47) |
| /v1/admin/ai-assist/* | JWT (super_admin) | AIアシスタント (Phase43) |
| /v1/admin/variants/* | JWT | A/Bテスト |
| /v1/admin/reports/* | JWT | 週次レポート |
| POST /api/avatar/room-token | x-api-key | LiveKit JWT発行 + Agent Dispatch |

## Security Middleware Order (src/index.ts)
1. requestIdMiddleware (global)
2. securityHeadersMiddleware (global)
3. express.json (global)
4. corsMiddleware (global — preflight handling)
5. rateLimiter (per-route stack)
6. authMiddleware (per-route stack)
7. tenantContextLoader (per-route stack)
8. securityPolicyEnforcer (per-route stack)

## Environment Variables
```bash
# Core
PORT, LOG_LEVEL, ES_URL, DATABASE_URL
ALLOWED_ORIGINS, DEFAULT_TENANT_ID

# Auth
AGENT_API_KEY, API_KEY_TENANT_ID, BASIC_AUTH_TENANT_ID
SUPABASE_URL, SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY

# LLM
GROQ_API_KEY, GROQ_CHAT_MODEL, GROQ_MODEL_8B, GROQ_MODEL_70B
LLM_API_KEY, LLM_BASE_URL, LLM_CHAT_MODEL, LLM_MODEL_20B, LLM_MODEL_120B
OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL
GEMINI_API_KEY  # Phase45 Judge専用

# Avatar (Phase40-41)
LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
FISH_AUDIO_API_KEY, FISH_AUDIO_REFERENCE_ID
LEMONSLICE_API_KEY, LEMONSLICE_AGENT_ID

# Storage
SUPABASE_STORAGE_URL, SUPABASE_BUCKET_BOOK_PDFS

# Billing (Phase32)
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

# Cross-encoder
CE_MODEL_PATH, CE_ENGINE

# Phase22 Flow Control
PHASE22_MAX_TURNS, PHASE22_MAX_CLARIFY_REPEATS
PHASE22_MAX_CONFIRM_REPEATS, PHASE22_LOOP_WINDOW_TURNS

# Phase45 Judge
JUDGE_AUTO_EVALUATE, JUDGE_SCORE_THRESHOLD

# Monitoring
SLACK_WEBHOOK_URL
```

## Deployment (Phase28)
- VPS: Hetzner 65.108.159.161
- API: PM2 → `node dist/index.js` (port 3100)
- Admin UI: PM2 → `serve -s admin-ui/dist` (port 5173)
- Admin UI API base: `VITE_API_BASE` 環境変数 (default: localhost:3100)
- Deploy: `bash SCRIPTS/deploy-vps.sh [user@host]`
- Checklist: `docs/DEPLOY_CHECKLIST.md`
- PM2 processes (ecosystem.config.cjs):
  1. `rajiuce-api` — `dist/src/index.js` (port 3100)
  2. `rajiuce-avatar` — `avatar-agent/agent.py` (LiveKit Agent)
  3. `rajiuce-admin` — `serve admin-ui/dist -l 5173`
  4. `slack-listener` — `slack_listener.py`

## Cost Constraint
- Monthly: $27-48
- Grafana + Prometheus: self-hosted $0-5
- Slack Webhook: free
- Groq API: usage-based (120B ratio ≤10%)

## VPSデプロイルール（厳守）

⚠️ 以下のルールはClaude Code CLIが必ず従うこと。ユーザーへの提案時も同様。

### デプロイコマンド

```bash
bash SCRIPTS/deploy-vps.sh
```

これが唯一のデプロイ手順。以下の個別コマンドは禁止:
- ❌ `ssh root@... "git pull && pnpm build && pm2 restart"`
- ❌ `ssh root@... "cd admin-ui && pnpm build"`
- ❌ VPSで直接 `git pull` を実行

deploy-vps.sh は rsync + API build + Admin UI build（キャッシュクリア付き）+ バンドル検証 + PM2 restart を一括で行う。

### 重要な注意事項
- ecosystem.config.cjs の script は `dist/src/index.js`（`dist/index.js` ではない）
- PM2は `.env` を自動で読まない。dotenv/config が src/index.ts の先頭でimportされている
- Admin UIは `serve -s admin-ui/dist -l 5173` で静的ファイル配信

## Security Scan
- デプロイ前: bash SCRIPTS/security-scan.sh を実行推奨
- CI: .github/workflows/security-scan.yml が main push / PR / 週次で自動実行
- ポリシー: docs/SECURITY_SCAN_POLICY.md 参照
- High/Critical 検出時はデプロイをブロック

## Test & Deploy Gate（必須フロー）

実装完了 → pnpm verify → security-scan.sh → pnpm build → deploy-vps.sh → ポストデプロイ確認

**Gate通過なしのデプロイは禁止。**

詳細: docs/TEST_DEPLOY_GATE.md

## Settings Hygiene
- `.claude/settings.local.json` は `.gitignore` に登録済み（プロジェクトローカルルール）
- allowedTools にAPIトークン・パスワード等の認証情報を含めない
- 禁止デプロイコマンドを allowedTools に追加しない（deploy_guard.py フックが検知）
