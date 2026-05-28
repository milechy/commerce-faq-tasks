# RAJIUCE Handoff Document

## Quick State
- Phase 70: 24h 自走ループ確立済み (2026-05-28) ✅ 完全自走確定
- Active: Phase53残 (book id=1 VPS復旧) → Phase54 billing → pipelineQueue永続化
- 24h Loop: Tier-S id=4 試運転中 (3日連続成功で正式承認、14日でDoD)

## 2026-05-28 成果サマリ

### 午前: 24hループ確立
- 6罠攻略 PR #197/#217/#218/#219/#220/#221/#222/#223 (Phase70完了)
- e2e #6 launchd実起動 40秒自走成功で完全自走確定
- CLI主体制移行 (Claude Code CLI=主担当、Claude.ai=サブ)

### 午後: 24タスク実装 (PR #224/#225/#226)
- **PR #224**: UI text修正・HTTP環境マイク非表示・anti-slop.md・architecture.md・HANDOFF.md・skills version追加・grill-me/brainstorm/plan/compound新規
- **PR #225**: CI pipeline (Gate1+Gate3: typecheck+lint+test+build)
- **PR #226**: Phase44 book_uploads migration SQL (5 status + pipeline追加カラム)
- settings.local.json: 314→250件 (ssh:*/rsync 63件危険権限削除)
- Phase44 P0〜P1-RAG: コード実装済みを確認 (37テスト全通過)
- Phase53調査: book id=1 停滞の根本原因 = pipelineQueue in-memory設計 (PM2再起動でジョブ消失)

### 起票 (2026-05-28)
- GID 1215190233020663: [P2] pipelineQueue 永続化 (→ lane-49 既に稼働中!)
- GID 1215190503585022: [P3] principleSearch.ts global tenant対応 (→ queue id=48 pending)
- GID 1215190164957424: [調査] 本番 .env プレースホルダ確認 (→ lane-50 既に稼働中!)

## 残人手タスク (hkobayashi実行)
1. book id=1 VPS復旧: `POST /v1/admin/knowledge/book-pdf/1/process` (super_admin JWT — 手順は本日Claudeセッションログ参照)
2. Phase44 P2 VPS: `psql $DATABASE_URL < src/migrations/phase44_book_uploads.sql` → `bash SCRIPTS/deploy-vps.sh`
3. Supabase Storage: `book-pdfs` バケット作成 (private)
4. PostToolUse hook (typecheck自動化): settings.json Edit は deny層でブロック → 手動追加必要
5. 本番 .env FAL_KEY=\<your-fal-key\> 等プレースホルダ確認 (lane-50が調査中)

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
