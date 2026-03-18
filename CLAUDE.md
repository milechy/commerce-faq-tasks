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

## Key Endpoints
| Path | Auth | Purpose |
|---|---|---|
| POST /api/chat | x-api-key | Widget → Chat |
| POST /dialog/turn | x-api-key / JWT | Multi-turn dialog |
| POST /agent.search | x-api-key / JWT | RAG search |
| GET /health | public | ES/PG/CE health |
| GET /metrics | X-Internal-Request: 1 | Prometheus metrics |

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
PORT, LOG_LEVEL, ES_URL, DATABASE_URL
AGENT_API_KEY, ALLOWED_ORIGINS
API_KEY_TENANT_ID, BASIC_AUTH_TENANT_ID
CE_MODEL_PATH, CE_ENGINE
SLACK_WEBHOOK_URL
PHASE22_MAX_CONFIRM_REPEATS, DEFAULT_TENANT_ID
QWEN_API_KEY, OPENAI_API_KEY
```

## Deployment (Phase28)
- VPS: Hetzner 65.108.159.161
- API: PM2 → `node dist/index.js` (port 3100)
- Admin UI: PM2 → `serve -s admin-ui/dist` (port 5173)
- Admin UI API base: `VITE_API_BASE` 環境変数 (default: localhost:3100)
- Deploy: `bash SCRIPTS/deploy-vps.sh [user@host]`
- Checklist: `docs/DEPLOY_CHECKLIST.md`

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
