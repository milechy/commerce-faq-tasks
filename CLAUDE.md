# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check .wolf/cerebrum.md before generating code. Check .wolf/anatomy.md before reading files.


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
- Public URLs (Phase49):
  - API: https://api.r2c.biz (Nginx → PM2 port 3100)
  - Admin UI: https://admin.r2c.biz (Nginx → serve port 5173)
  - SSL: Let's Encrypt (certbot --nginx, auto-renew)
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

⚠️ 全Phaseに適用。Gate通過なしのデプロイは禁止。

### Gate順序（実装完了後に必ずこの順で実行）

```
実装完了
  → Gate 1: pnpm verify（typecheck + lint + test 全パス）
  → Gate 2: bash SCRIPTS/security-scan.sh（High/Critical = 0）
  → Gate 2.5: /codex:review --base main --background
              → /codex:result
              ★ 必ずgit push前に実行（push後は差分なしで無意味）
              ※ セキュリティ変更時のみ: /codex:adversarial-review --background
              ※ Critical/High指摘 → 修正 → Gate 1から再実行
  → Gate 3: pnpm build && cd admin-ui && pnpm build
  → git commit + push（Gate 1-3通過後のみ）
────────────────────────────────
以降は人間が実行:
  → Gate 4b: claude --chrome でブラウザテスト（★ UI変更Phase: 必須）
  → デプロイ: bash SCRIPTS/deploy-vps.sh
  → DBマイグレーション: VPSでSQL手動実行（あれば）
  → Gate 5: curl https://api.r2c.biz/health + Admin UIログイン確認
  → Gate 6: UI調査（★ UI変更Phase: 必須・Claude in Chrome）
  → Asanaタスク完了 + ドキュメント更新
```

### Codex Review 運用ルール
- review gate: **常時OFF**（自動ループはコスト消費が大きすぎる）
- 通常レビュー: PR前に1回だけ `/codex:review --base main --background`（**git push前**）
- セキュリティ変更時のみ: `/codex:adversarial-review --background`
- 結果確認: `/codex:status` → `/codex:result`
- Critical/High → 修正必須。False positive → スキップ理由をコミットメッセージに記載
- スキップOK: typo修正、ドキュメントのみ、CSSのみ、テストコードのみ

### テスト作成ルール
- 新規API: 正常系1 + 認証エラー1 + バリデーション1（最低限）
- セキュリティ関連: 全パスカバー
- 外部API（Groq, Gemini, Supabase Storage, Fish Audio等）: 常にモック
- Gate 1-3が通らない限りgit pushしない
- ★ Gate 2.5（Codex review）はgit push前に実行（push後は差分なしで無意味）

### Chrome ブラウザテスト（UI変更Phase: 必須）
- `claude --chrome` で実行（Gate 4b）
- 共通項目: ログイン / ダッシュボード表示 / 🔔通知ベル / モバイル390px / コンソールエラーなし
- `~/.claude/settings.local.json` に `"mcp__claude-in-chrome__computer"` が必要
- ★ UI変更がないPhaseではスキップ可。UI変更があれば Gate 6（UI調査）も必須

詳細: docs/TEST_DEPLOY_GATE.md

## Settings Hygiene
- `.claude/settings.local.json` は `.gitignore` に登録済み（プロジェクトローカルルール）
- allowedTools にAPIトークン・パスワード等の認証情報を含めない
- 禁止デプロイコマンドを allowedTools に追加しない（deploy_guard.py フックが検知）

## Custom Agents (.claude/agents/)

プロジェクト固有のサブエージェント。`@エージェント名` で呼び出す。

| Agent | 用途 | 呼び出し |
|---|---|---|
| gate-runner | Gate 1〜3一括実行 + フォーマット報告 | @gate-runner |
| cleanup | dead exports削除、any型付け、as any除去 | @cleanup |
| deploy-checker | VPSデプロイ前後チェックリスト | @deploy-checker |
| test-writer | テスト作成（モック方針・配置ルール準拠） | @test-writer |

### 環境変数（Claude Code最新機能用）
- `CLAUDE_CODE_NO_FLICKER=1` — Focus View有効（Ctrl+Oで切替）
- `MCP_CONNECTION_NONBLOCKING=true` — FT Pipeline --print高速化

## MCP Integrations

### Playwright MCP (E2E Browser Testing)
- Setup: `claude mcp add --scope project playwright npx @playwright/mcp@latest`
- Usage: 「Playwright MCPでadmin.r2c.bizにアクセスして〇〇をテストして」
- Gate 4b/Gate 6 のブラウザテストをCLIから自動実行可能
- 初回は明示的に「Playwright MCP」と言うこと（Bash実行と区別するため）
- 認証: ログイン画面が表示されたら人間が手動ログイン→Cookie維持

### Environment Variables (Performance)
```bash
# ~/.zshrc に追加済み
export ENABLE_PROMPT_CACHING_1H=1    # 1時間プロンプトキャッシュ
export CLAUDE_CODE_NO_FLICKER=1       # フリッカー防止
export MCP_CONNECTION_NONBLOCKING=true # MCP非同期接続
```

### Session Features
- `/recap` — セッション復帰時のコンテキスト自動要約
- `/review` — コードレビュー（Skill tool経由で自動発見可能）
- `/security-review` — セキュリティレビュー

## OpenWolf（トークン最適化ミドルウェア）
- `.wolf/` にプロジェクトインデックス・学習メモリ・トークンレジャーを保持
- 6つのフックスクリプトがClaude Code操作時に自動実行
- ファイル読み取り前に `anatomy.md` で内容を要約 → 不要な全文読み取りを削減
- `cerebrum.md` に過去の修正・好みを蓄積 → セッション間で学習
- コスト $0（ローカル処理のみ、外部API不使用）
- `openwolf status` で健全性確認、`openwolf scan` で構造マップ更新
- `.wolf/` は `.gitignore` 登録済み（ローカルのみ）
