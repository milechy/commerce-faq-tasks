---
name: architecture
description: RAJIUCE system architecture overview — layers, security middleware, key directories
version: 1.0.0
---

# RAJIUCE Architecture

## Layer Overview

```
Widget (public/widget.js)
  └── Shadow DOM, 1-line embed, data-api-key auth
      ↓
API (src/index.ts)
  └── Express + 4-layer security stack
      ↓
RAG Pipeline
  └── pgvector + Elasticsearch → Cross-encoder rerank → Groq 20B/120B
      ↓
LLM (Groq / Gemini)
  └── 20B default, 120B for complex queries/safety only (≤10% ratio)
```

## Security Middleware Order (src/index.ts)

1. `requestIdMiddleware` — global
2. `securityHeadersMiddleware` — global
3. `express.json` — global
4. `corsMiddleware` — global (OPTIONS preflight handling)
5. `rateLimiter` — per-route stack
6. `authMiddleware` — per-route stack
7. `tenantContextLoader` — per-route stack
8. `securityPolicyEnforcer` — per-route stack

## LLM Defense Layers (Phase48)

- L5: Input Sanitizer
- L6: Prompt Firewall
- L7: Topic Guard
- L8: Output Guard

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | Backend TypeScript source |
| `src/index.ts` | Entry point (Express app setup) |
| `admin-ui/` | React + Vite admin UI |
| `public/widget.js` | 1-line embeddable widget |
| `SCRIPTS/` | Operational scripts (deploy, monitor, 24h-mode) |
| `docs/` | Architecture, API reference, playbooks |

## Key Entry Points

- **Production**: `dist/src/index.js` — NOT `dist/index.js`
- **Development**: `src/index.ts` via ts-node-dev
- **Admin UI**: `admin-ui/src/main.tsx`

## Data Flow (Conversation)

```
clarify → answer → confirm → terminal   (Phase22 State Machine)
clarify → propose → recommend → close   (Phase28 SalesFlow)
```

## Infrastructure

- Node 20 + Express on Hetzner VPS (PM2)
- PostgreSQL 16 + pgvector (`faq_embeddings` vector(1536))
- Elasticsearch 8 (`faqs` index, BM25 full-text)
- Supabase Auth (admin UI JWT)
- Prometheus + Grafana + Slack AlertEngine (Phase24)
- Gemini 2.5 Flash for Judge/Gap (Phase45/46)

## Multi-tenant Design

- All data rows carry `tenant_id`
- `tenantId` resolved from JWT or API key only — never from `req.body`
- ES + PG queries always filtered by `tenant_id`
