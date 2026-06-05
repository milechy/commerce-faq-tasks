# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check .wolf/cerebrum.md before generating code. Check .wolf/anatomy.md before reading files.


# 運用体制(2026-05-28〜)

- **Claude Code CLI = 主担当**。調査/実装/Gate/PR/ログ/DB/VPS/grep/Playwright、実機作業すべて。Asanaタスクを自走で実装まで進める。
- **Claude.ai = サブ**。実機に触れない判断のみ。止めるのは4点だけ: ①merge可否 ②Codex結果(実害セキュリティ) ③Phase/スコープ方針 ④不可逆操作。
- **24hループ(Phase70)は2026-05-28に完全自走確定**（6罠攻略、PR #197/#217/#218/#219/#220/#221/#222）。Tier-S id=4 試運転中。
- CLIは段取り/設定/接続/worktree/調査/テスト/機械チェックで止まらず自走、結果のみ報告。

## セッション開始時の必須確認（毎回）

CLIは新セッション開始時に以下を確認・報告する（省略禁止）:
- `claude --version`（最新版との差分を確認）
- `claude plugin list`（導入済みプラグイン一覧）
- `.claude/skills/`・`.claude/agents/`・`.claude/hooks/` の現状
- 公式 changelog（https://code.claude.com/docs/en/changelog）から前回確認版以降の新機能を抽出
- 当日タスクに活用できる新機能・資産を能動的に提案する（確認だけで終わらせない）

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

## Auto Mode 運用ルール（Claude Code v2.1.83+）

⚠️ Auto Modeは Sonnet 4.6 ベースの分類器が各ツールコールを事前審査する研究プレビュー機能。
`--dangerously-skip-permissions` より安全だが完全ではない。以下のルールを厳守すること。

### 起動と切替

```bash
claude --enable-auto-mode    # 初回のみ
# セッション内で Shift+Tab を押してモード切替
# default → acceptEdits → plan → auto の順にサイクル
```

ステータスバーが **赤色スピナー** で表示されていればauto有効。

### 使用OK（Auto Modeで実装する）

- feature branch上での実装作業
- pnpm install / pnpm verify / pnpm test / pnpm build
- src/, app/, components/, admin-ui/, docs/, SCRIPTS/ の編集
- git add / git commit / git push（feature branchのみ）
- Asana MCP / Playwright MCP の読み取り操作

### 使用NG（必ず Shift+Tab で default に戻す）

| 操作 | 理由 |
|---|---|
| `bash SCRIPTS/deploy-vps.sh` 実行前後 | 本番デプロイは必ず人間が承認 |
| DB migration SQL実行 | 不可逆操作 |
| main branch操作 | Branch Rule厳守（Gate 2.5の前提） |
| `.env` / `.env.local` / `.env.production` 編集 | 機密情報リーク防止（denyルールでも保護） |
| 書籍PDF / Convex DB seed / シークレット系 | LLM学習防止制約と整合 |
| `/opt/rajiuce/` 配下の操作 | VPS本番領域（denyルールでも保護） |

### 既知バグの回避

- `defaultMode: "auto"` は settings.json で **効かない**（Issue #49273）
  → 毎セッション手動で Shift+Tab する
- 「pushしないで」等の自然言語境界は **context compaction後に消失**（Issue #51689）
  → ハード禁止は `permissions.deny` に書く
- 分類器がOpus 4.7を呼ぶケースあり（Issue #49837）
  → コスト・レイテンシが想定より上がる可能性

### permissions.deny で保護されている範囲（参考）

`~/.claude/settings.local.json` の `permissions.deny` で以下を多重防御:
- `.env` 系全般（`.env.example` は除外＝編集可）
- VPS SSH・rsync コマンド
- `/opt/rajiuce/**` への書き込み
- main branch への直接push
- `rm -rf /` 系の破壊的コマンド

### Gate ワークフローとの整合

- Gate 1-3（@gate-runner）はAuto Modeで快適に回せる
- Gate 2.5（Codex review）は引き続き **人間が手動実行**（Auto Mode関係なし）
- Gate 4b/6（Playwright MCP / Chrome）は通常モードで実行推奨

### トラブル時のリセット

```bash
# Auto Modeを完全停止したい場合
# セッション内で Shift+Tab を押し続けて default に戻す
# 緊急時: Ctrl+C でセッション終了、claude を default モードで再起動
```

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

## Claude.ai 振る舞いルール (UATa 16事例導出 2026-05-20)

出典: `docs/UATA_R2C_DIFF_ANALYSIS.md` / UATa 24h 1日実体験生記録 v1.0

### 1. Claude.ai 生成プロンプトの禁止事項
- `docker compose ... build` 直接コマンドを含めない
- VPS デプロイは `bash SCRIPTS/deploy-vps.sh` 等の wrapper script 経由のみ
- UATa 事例 #8: PR #191 で `--env-file` 抜けて本番 wallet 死亡、4-5h 復旧

### 2. Lane / CLI プロンプト発行前の実機照合必須
- memory 記載のファイル名・endpoint・import path は古い可能性あり
- 必ず CLI に「該当ファイル / grep / git log で実機照合」→ 結果貼り戻し後にプロンプト発行
- UATa 事例 #9: 鉄則 8 違反 3 連続でセッション信頼失墜

### 3. CLI 報告の「全停止」鵜呑み禁止
- 「中止推奨」「全停止」「制約あり」レポートは 4 軸再確認必須
- 4 軸: 観測 (curl/frontend/agent/backend) / 環境 (production/staging/dev) / 時間 (今日/既解消/未解消) / 影響 (当該 Lane/Phase 全体/全停止)
- UATa 事例 #15: 鵜呑みで 4 Lane 全停止指示

### 4. Opus 障害時の Sonnet 退避ルート

Sonnet 4.6 で進められる作業:
- read-only 調査
- `.claude/agents/` + `.claude/skills/` + `docs/` 更新
- pytest / E2E 追加のみの PR
- Phase 1-2 (コード把握 + test 設計)
- PR 作成 (Gate 4 一部保留可)

Sonnet 4.6 不可、Opus 復旧待ち:
- Tier S 直列
- 大規模リファクタ
- セキュリティ系本体修正
- 安全装置配線変更
- 本体最終実装

UATa 事例 #14: Opus 障害で 3 Lane 全停止 → Sonnet 退避未確立で大幅遅延

### 5. Phase 計画立案前の 5 軸事前確認
- 凍結期限 / UAT 状況 / API 障害 / 期限タスク / 過去 postmortem P1 未済
- UATa CLAUDE.md §4「Phase 計画立案 必須セクション」を R2C に移植検討

## 24h ループ安定性ガード（点火前要件 — UATa 3日運用導出）

UATa 3日自走（stop_hook 144件）で判明した停止原因への恒久対策。Lane / Team Lead 双方が遵守する。

### 1. 並列上限（要件5a — result drop 回避）
- **同時稼働 Lane は最大 3 本**（`r2c-dispatch.sh` の `MAX_SLOTS=3`）。
- **1 セッション内の並列 tool call も 3 本未満**に保つ。
- 根拠: 同時 3 本超で Claude Code の result drop / context 断絶が多発（公式 issue #39830、UATa 実測 154件）。
- Team Lead が手動で Lane を起こす場合もこの上限を超えない。

### 2. CI 待ちプロトコル（要件1 — 無限待ち禁止 / Lane 内 20分 timeout）
- Lane は CI 完了を**最大 20 分**しか待たない。超えたら人間へ通知して次へ進む（ブロックしない）。
- `gh run watch` には timeout フラグが無く、`timeout(1)` も非搭載環境があるため、**deadline ループ**で自己制御する:
  ```bash
  run_id=$(gh run list --branch "$BR" --limit 1 --json databaseId -q '.[0].databaseId')
  deadline=$(( $(date +%s) + 1200 ))   # 20分
  while :; do
    st=$(gh run view "$run_id" --json status,conclusion -q '.status+":"+(.conclusion//"")')
    case "$st" in
      completed:success) echo "CI OK"; break ;;
      completed:*)       echo "CI NG: $st"; break ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      bash SCRIPTS/notify-slack.sh "⚠️ CI 20分超過、人間確認へ: run $run_id" --color warning
      break
    fi
    sleep 30
  done
  ```
- supervisor は stuck Lane を **45分**で検出・retry する（`MAX_RUN_MINUTES=45`）。CI 待ちはそれより内側の 20分で必ず畳む。

### 3. コンテキスト断絶の復元プロトコル（要件5b）
- Lane が `previous_message_not_found` / context 断絶を検知したら、その場で粘らず:
  1. 現在の作業状態（branch / 最後に通過した Gate / 次の手順）を auto-memory（`MEMORY.md`）に必ず書く。
  2. Lane を一旦終了し、Team Lead が再 dispatch する（`r2c-dispatch.sh --task-id <id>`）。
  3. 再起動後の Lane は `MEMORY.md` から前回状態を復元してから再開する。
- 断絶したまま推測で続行しない（誤った差分の量産を防ぐ）。

## auto-memory (MEMORY.md) 運用ルール（UATa 3日運用導出）

UATa の24hループで「状態スナップショット/GID一覧/完了済み作業を memory に書いて3日で腐る」が
最大のノイズ源と判明。R2C は今日点火。以下のフィルタを先回りで適用する。

### 1. 書き込み前3問フィルタ（全Laneに適用）

MEMORY.md に書く前に必ずこの3問を通過させること:

- **Q1 コードを読めば分かるか?** → Yes なら書かない（コードが正典）
- **Q2 2週間後も正しいか?** → No なら書かない（腐る情報は毒）
- **Q3 次の自分が罠を踏まずに済むか?** → Yes なら書く（これだけが memory の存在理由）

**書いてはいけないもの（腐る）**:
- 状態スナップショット（「現在 Phase70-K が進行中」等）
- Asana GID 一覧・PR番号・Issue番号
- 完了済み作業の記録
- 一時的な障害状況・API 障害メモ

**書くべきもの（腐らない）**:
- 罠の構造（「なぜこのパスが誤検知されるか」等）
- 確認手順（実機で確認しないと分からない手順）
- ユーザー修正から得た preference（「こうではなくこうやれ」）
- 環境固有のデプロイ・接続の gotcha

### 2. ルール変更は CLAUDE.md が先（memory は経緯のみ）

ルール・禁止事項・ゲート条件を変更する場合:

1. **CLAUDE.md を先に更新する**（全 Lane が読む正典）
2. memory には「なぜ変えたか」の経緯のみ書く（差分の理由）
3. memory にルールを先書きしない（CLAUDE.md と矛盾する二重状態を作らない）

UATa 事故: memory にルール先書き → CLAUDE.md と矛盾 → Lane 間で異なる動作。

### 3. 役割分担（CLAUDE.md vs MEMORY.md）

| 内容 | 書く場所 |
|------|---------|
| 全 Lane 共通の禁止事項 | CLAUDE.md |
| Tier 分類・ゲート条件 | CLAUDE.md |
| 運用プロトコル・フロー | CLAUDE.md |
| 罠の構造・誤検知パターン | MEMORY.md |
| 実機確認しないと分からない手順 | MEMORY.md |
| ユーザー preference（修正から得たもの） | MEMORY.md |
| CLAUDE.md に書けない理由がある経緯 | MEMORY.md |

## 学習セクション (Auto-updated by Claude Code)

<!-- このセクションは Claude Code の auto-memory 機能により管理される -->
<!-- 手動編集不要。memory path: ~/.claude-r2c-config/projects/-Users-hkobayashi-projects-commerce-faq-tasks/memory/ -->

- **Memory path**: `~/.claude-r2c-config/projects/-Users-hkobayashi-projects-commerce-faq-tasks/memory/`
  - `CLAUDE_CONFIG_DIR=~/.claude-r2c-config` 環境変数でデフォルト `~/.claude/` から変更済み
- **OpenWolf 役割分離 (24h自走中)**:
  - `.wolf/cerebrum.md` / `.wolf/memory.md` = Read-Only (24h自走中)
  - `MEMORY.md` (auto-memory) = 唯一の書き込み可能領域
- **設定**: `.claude/settings.json` の `autoMemoryEnabled: true` で有効化済み（`~/.claude-r2c-config/settings.json` にも明示）
- **Lane Agent Memory**: 全 5 Lane エージェントが `memory: project` スコープで共有 MEMORY.md を参照・書き込み
- **メモリ 4 層アーキテクチャ**:
  - Layer 1: `MEMORY.md` — 書き込み可、feedback/project/user/reference 型、3 問フィルタ必須
  - Layer 2: `.wolf/anatomy.md` — Read-Only、ファイルインデックス (16.7M tok 削減)
  - Layer 3: `.wolf/buglog.json` — Read-Only、構造化バグログ 6000+ 件
  - Layer 4: `.wolf/cerebrum.md` — Read-Only (24h自走中)、key learnings / do-not-repeat
  詳細: `docs/R2C_DEVELOPMENT_PLAYBOOK.md §15.6`

## 24h ループ Lane spawn 経路の罠 6 層 (Phase 70 終結、2026-05-28)

2026-05-26〜28 の OAuth daemon 凍結事故と e2e 検証で 24h ループ自走の障害を 6 層解明。
PR #197/#217/#218/#219/#220/#221 で全カバー、e2e #6 (launchd 実起動 task 47 で 40 秒自走成功) で完全復活確定。

### 最大教訓
**launchd 実起動経由で検証しないと罠を見逃す**。interactive shell 成功 ≠ launchd 成功
(PR #220 env -i がこれで裏切った)。修正 PR の前に **launchd cron 1分毎の自然拾い** で
result file 生成を 120 秒以内に観測することを必須ゲートにすること。

### 6 PR 対応表

| 罠 | 内容 | 解消 PR | 修正概要 |
|---|---|---|---|
| 1 | OAuth daemon 凍結 | #197 | auth fail-fast 化 (`claude /login` 手動復旧、headless 不可) |
| 2 | `--prompt-file` v2.1.152 廃止 | #218 | `cat prompt \| claude --bg ...` (stdin pipe) |
| 3 | dispatch.sh `export PATH=` が stdin pipe を壊す | #219 | export PATH= 行削除 |
| 4 | lane-*.log 0byte/223byte ≠ 即死 (解釈罠) | #217 (resolver 安全装置) | `(idle — send a prompt to start)` バナーで判別 |
| 5 | cron-wrapper.sh の親 env 継承 | #220 | `env -i HOME PATH R2C_* CLAUDE_* bash ...` |
| 6 | launchd session/process group attribute | #221 | `/usr/bin/python3 -c 'os.setsid(); execvp(...)'` で session 分離 |

### OAuth 復旧手順 (罠1 発生時)

```bash
# 1. 状態確認
cat ~/.claude/daemon-auth-status.json    # {"status":"auth_required",...} なら罠1
# 2. hkobayashi 手動で /login (headless 不可)
claude /login
# 3. daemon が status.json を更新しない場合は強制再起動 (別ターミナルから)
pkill -f "claude.exe daemon"
pkill -f "claude.exe --bg-spare"
# 4. ファイル消失で valid 状態のシグナル
ls ~/.claude/daemon-auth-status.json   # No such file = OK
```

### 監視 (5 軸ヘルスチェック)
- `SCRIPTS/monitor-claude-health.sh` で 5 分毎チェック (`com.r2c.monitor.plist`)
- 軸A: OAuth fail / 軸B: claude --version 差分 / 軸C: lane-*.log 0byte 連続 / 軸D: dispatch idle / 軸E: session_id 未取得
- Slack `#rajiuce-dev` (C0AG07HFJTB) 通知、6h throttle

### ポストモーテム
- `docs/postmortem/2026-05-28-oauth-fail/MEMORY_27.md` (罠 6 層 + 切り分け手順、144 行)
- `docs/postmortem/2026-05-28-oauth-fail/MONITOR_TASK.md` (5 軸監視設計、81 行)
