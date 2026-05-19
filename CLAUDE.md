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
- Key endpoints / env vars: `docs/API_REFERENCE.md`

## Security Middleware Order (src/index.ts)
1. requestIdMiddleware (global)
2. securityHeadersMiddleware (global)
3. express.json (global)
4. corsMiddleware (global — preflight handling)
5. rateLimiter (per-route stack)
6. authMiddleware (per-route stack)
7. tenantContextLoader (per-route stack)
8. securityPolicyEnforcer (per-route stack)

## VPSデプロイルール（厳守）

⚠️ 唯一の手順: `bash SCRIPTS/deploy-vps.sh`
- ecosystem.config.cjs の script は `dist/src/index.js`（`dist/index.js` ではない）
- PM2は `.env` を自動で読まない (dotenv/config が src/index.ts 先頭でimport済み)
- 禁止: ssh直接コマンド / VPSで git pull / 個別 pnpm build
詳細: `docs/DEPLOY_CHECKLIST.md`

## Security Scan
- デプロイ前: `bash SCRIPTS/security-scan.sh` 実行推奨
- CI: .github/workflows/security-scan.yml が main push / PR / 週次で自動実行
- High/Critical 検出時はデプロイをブロック。ポリシー: `docs/SECURITY_SCAN_POLICY.md`

## Test & Deploy Gate（必須フロー）

⚠️ 全Phaseに適用。Gate通過なしのデプロイは禁止。詳細: `docs/TEST_DEPLOY_GATE.md`

Gate順序:
- Gate 1: `pnpm verify` (typecheck + lint + test 全パス)
- Gate 1.5: `bash SCRIPTS/dead-code-check.sh` (孤立コード確認)
- Gate 2: `bash SCRIPTS/security-scan.sh` (High/Critical = 0)
- Gate 2.5: `/codex:review --base main --background` (**git push前**に実行、`--base main` 省略禁止)
- Gate 3: `pnpm build && cd admin-ui && pnpm build`
- git commit + push (Gate 1-3通過後のみ)

Codex review gate: 常時OFF。スキップOK: typo修正・ドキュメントのみ・CSSのみ・テストコードのみ

## Git Branch Rule（厳守）

⚠️ **mainへの直接コミット禁止。test-onlyでも例外なし。**

```
git checkout -b feature/<asana-id>-<short-description>
```

違反復旧: `git reset --soft HEAD~1` → feature branch作成 → 再コミット
PR: `gh pr merge <PR番号> --auto --squash --delete-branch` 詳細: `docs/PR_MERGE_RULES.md`

## Settings Hygiene
- `.claude/settings.local.json` は `.gitignore` 登録済み（プロジェクトローカルルール）
- allowedTools にAPIトークン・パスワード等の認証情報を含めない
- 禁止デプロイコマンドを allowedTools に追加しない（deploy_guard.py フックが検知）

## Custom Agents (.claude/agents/)

| Agent | 用途 | 呼び出し |
|---|---|---|
| gate-runner | Gate 1〜3一括実行 + フォーマット報告 | @gate-runner |
| cleanup | dead exports削除、any型付け、as any除去 | @cleanup |
| deploy-checker | VPSデプロイ前後チェックリスト | @deploy-checker |
| test-writer | テスト作成（モック方針・配置ルール準拠） | @test-writer |

環境変数: `CLAUDE_CODE_NO_FLICKER=1` (Focus View), `MCP_CONNECTION_NONBLOCKING=true` (MCP高速化)

## MCP Integrations
- Playwright MCP (Gate 4b/6): `claude mcp add --scope project playwright npx @playwright/mcp@latest`
- Session: `/recap` (コンテキスト要約) / `/review` (コードレビュー) / `/security-review`

## OpenWolf（トークン最適化ミドルウェア）
- `.wolf/` にインデックス・学習メモリ・トークンレジャーを保持（`.gitignore` 登録済み）
- anatomy.md で不要な全文読み取りを削減、cerebrum.md でセッション間学習
- `openwolf status` で健全性確認、`openwolf scan` で構造マップ更新

## 開発プレイブック参照
詳細 (役割分担・CLIプロンプトテンプレート・セッション開始プロトコル): `docs/R2C_DEVELOPMENT_PLAYBOOK.md`

## 24h 自走中の禁止操作（Phase70-A — 必読）

24h 自走モード ON 中 (`~/.r2c-24h-mode` 存在時 または `R2C_24H_MODE=1`) は
以下の操作を **絶対に実施しない**。違反検知時は Slack #r2c に `HUMAN-REVIEW-REQUIRED`
投稿して自身を停止すること。

Out of scope 11項目: VPS 接続 / main merge / DB migration / .env 編集 / git force /
avatar-agent 操作 / Cloudflare 設定変更 / 依存メジャー bump / 法務文書編集 / 本番テナント影響 /
**deploy_guard.py・24h-mode スクリプト自己編集禁止** (deploy_guard.py が検知・ブロック)。

詳細・運用手順・トラブルシュートは **`docs/24H_AUTONOMOUS_PLAYBOOK.md`** を必ず読むこと。

ON/OFF 操作:
- ON: `bash SCRIPTS/24h-mode-on.sh` (dry-run: `--dry-run`)
- OFF: `bash SCRIPTS/24h-mode-off.sh`
- 検知 hook: `.claude/hooks/deploy_guard.py` が `R2C_24H_MODE` を読み追加ブロック実施

## 3 回ルール（UATa PR #246 教訓 — Phase70-K 追加）

**同系統のミスを 3 回繰り返したら、その判断は hkobayashi が引き取る。**

適用されるミスタイプ（例）:
1. **推測ベース書き換え** — 実機確認せずに変更 → 確認後に提案
2. **メモリ盲信** — memory 参照後に実機状態を未確認 → 対応ファイル・コマンドで確認
3. **並列化忘れ** — セッション開始時に並列可能性を未検討 → 初手でマトリクス化

資格喪失後の再開条件: ガード/監視の実装完了後。
詳細: `docs/R2C_24H_STARTUP_CHECKLIST.md §5.3`

## 学習セクション (Auto-updated by Claude Code)

<!-- このセクションは Claude Code の auto-memory 機能により管理される -->
<!-- 手動編集不要。memory path: ~/.claude/projects/-Users-hkobayashi-Documents-GitHub-commerce-faq-tasks/memory/ -->

- **Memory path**: `~/.claude/projects/-Users-hkobayashi-Documents-GitHub-commerce-faq-tasks/memory/`
- **OpenWolf 役割分離 (24h自走中)**:
  - `.wolf/cerebrum.md` / `.wolf/memory.md` = Read-Only (24h自走中)
  - `MEMORY.md` (auto-memory) = 唯一の書き込み可能領域
- **設定**: `.claude/settings.json` の `autoMemoryEnabled: true` で有効化済み
