# RAJIUCE CLAUDE.md

## Core Principles
1. **Security First** — Book content never leaves Convex DB. RAG excerpts ≤200 chars. API keys hashed.
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
- tenantId: JWTから取得、bodyから禁止
- console.log(ragContent) 禁止
- 70Bモデル: 複雑クエリのみ

## Agent Repos
| エイリアス | パス |
|---|---|
| Agent-A-Auth | /Users/hkobayashi/commerce-faq-agent-auth-tenant |
