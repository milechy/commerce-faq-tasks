# RAJIUCE Handoff Document

## Quick State
- Phase 70: 24h 自走ループ確立済み (2026-05-28) ✅
- Active: 昨夜残務・インフラ復旧完了 (2026-05-29)。dispatch 停止中 → #237 merge 後に hkobayashi が手動再開予定。
- 24h Loop: dispatch/poll/supervisor bootout 中（launchd 停止）。monitor は #233 版で LastExitStatus=0 で稼働中。

## 残人手タスク (hkobayashi 実行)
1. **dispatch 再開** (#237 merge 後):
   ```
   sqlite3 ~/projects/commerce-faq-tasks/.claude/queue/r2c-queue.db \
     "INSERT OR REPLACE INTO automation_state(key,value) VALUES('pause_dispatching','0');"
   for l in dispatch poll supervisor; do
     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.r2c.$l.plist
   done
   ```
2. book id=1 VPS復旧: `POST /v1/admin/knowledge/book-pdf/1/process` (super_admin JWT)
3. Phase44 P2 VPS: `psql $DATABASE_URL < src/migrations/phase44_book_uploads.sql` → deploy

## 2026-05-29 成果サマリ

### インフラ復旧 (昨夜残務 ①②③)

**① Gate1 OOM 根治 PR #236** (sha=5b0e2c7d0d19) — merged ✅
- 切り分け: docs-only PR でも OOM → main 由来確定。
- 真因: `bookPdfRoutes.test.ts` が `pipelineQueue.enqueue` を未 mock → DB-backed queue(#227) と mock db が非同期無限ループ → JS heap OOM。Gate1 赤化は #227 merge と時期一致。
- 修正: test に `jest.mock(pipelineQueue)` (本番無変更) + `isolatedModules:true` + CI `NODE_OPTIONS=6144`。142 suites/1721 tests 全通過。Gate1 5分 OOM → 1分完走。

**② supervisor 誤 rollback 根治 PR #237** (sha=9ec767c78251) — merged ✅
- 真因: running>45min 検出時に PR 存在確認なし。Lane が PR を出しても state 遷移漏れで running のまま → 5 レーン (id=49/50/52/53/54) が auto_rollback された。
- 修正: kill 前に `gh pr list --head <branch>` で確認。OPEN=pr_created / MERGED=merged / CLOSED=フォールスルー。
- Codex Gate 2.5: P0/P1 なし、P2 指摘(CLOSED→pr_created 非終端放置)を修正済み。
- キュー整合済: 49/50→merged, 52/53/54→pr_created (+pr_number)。

**③ Codex Gate 2.5 復旧確定** — #237 で実走・完走ログ取得・PR コメント投稿済み ✅

### その他 merged PR (2026-05-29)
| PR | sha | 内容 |
|---|---|---|
| #233 | 7a2d155c77dd | fix(monitor): bash 5.3.3 `$current。` 誤展開修正 → monitor LastExitStatus=0 ✅ |
| #232 | eed25ebc5dd9 | docs(postmortem): Tier-S id=4 固着 + single-slot 調査レポート |
| #234 | a1c64b58a84b | fix(supervisor): started_at=NULL stuck 検出漏れ修正 |
| #235 | fa302f4fb001 | docs(gitleaks): allowlist + docs org UUID redact |

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
