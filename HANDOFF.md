# RAJIUCE Handoff Document

## Quick State
- Phase 70: 24h 自走ループ確立済み (2026-05-28)
- Active: Phase44 書籍RAG実装 → Phase53/54 進行中

## Architecture Layers
- Phase22: State Machine (clarify→answer→confirm→terminal)
- Phase24: Prometheus + Grafana + Slack AlertEngine
- Phase28: SalesFlow (clarify→propose→recommend→close)
- Phase44: Book RAG (PDF→pgvector+ES)
- Phase48: LLM Defense L5-L8

## Deploy Gotchas
- **CRITICAL**: ecosystem.config.cjs script は `dist/src/index.js` (NOT `dist/index.js`)
- deploy-vps.sh のみ使用: `bash SCRIPTS/deploy-vps.sh`
- PM2は .env を自動で読まない (dotenv/config が src/index.ts 先頭で import 済み)
- Admin UI build には VITE_SUPABASE_URL 等の環境変数が必要

## 24h Loop
- ON: `bash SCRIPTS/24h-mode-on.sh`
- OAuth 凍結時: `cat ~/.claude/daemon-auth-status.json` → `claude /login`
- 監視: `SCRIPTS/monitor-claude-health.sh` (5分毎, 5軸チェック)

## Gate Sequence
Gate 1 → 1.5 → 2 → 2.5 → 3 → push → PR
- Gate 1: `pnpm verify`
- Gate 3: `pnpm build && cd admin-ui && pnpm build`
