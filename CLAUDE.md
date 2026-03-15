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

## VPSデプロイ手順（必須）

VPSは `dist/src/index.js`（TypeScriptコンパイル済みJS）をPM2で実行しています。
TypeScriptの変更後は **必ず `pnpm build` が必要** です。

### バックエンド変更時（src/ 配下）
```bash
cd ~/Documents/GitHub/commerce-faq-tasks
git add -A && git commit -m "説明" && git push origin main
ssh root@65.108.159.161 "cd /opt/rajiuce && git pull origin main && pnpm install && pnpm build && pm2 restart rajiuce-api"
```

### フロントエンド変更時（admin-ui/ 配下）
```bash
cd ~/Documents/GitHub/commerce-faq-tasks
git add -A && git commit -m "説明" && git push origin main
ssh root@65.108.159.161 "cd /opt/rajiuce && git pull origin main && cd admin-ui && pnpm build && pm2 restart rajiuce-admin"
```

### 両方変更時
```bash
cd ~/Documents/GitHub/commerce-faq-tasks
git add -A && git commit -m "説明" && git push origin main
ssh root@65.108.159.161 "cd /opt/rajiuce && git pull origin main && pnpm install && pnpm build && pm2 restart rajiuce-api && cd admin-ui && pnpm build && pm2 restart rajiuce-admin"
```

### 重要な注意事項
- `pnpm build` を忘れるとTypeScriptの変更が反映されない
- ecosystem.config.cjs の script は `dist/src/index.js`（`dist/index.js` ではない）
- PM2は `.env` を自動で読まない。dotenv/config がsrc/index.tsの先頭でimportされている
- Admin UIは `serve -s admin-ui/dist -l 5173` で静的ファイル配信
