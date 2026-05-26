# Claude Code 完全活用ガイド (R2C)

> 実機照合日: 2026-05-26 / Claude Code 2.1.150
> 全記載事実は `grep` / `cat` / `gh` / `git` で確認済み。推測禁止 (#27)。

---

## 第1部 CLI 機能棚卸し

### 凡例
| 記号 | 意味 |
|------|------|
| ✅ 使用中 | R2C 設定に実際に存在・稼働 |
| 🔶 未活用だが有効 | 有効だが未設定。採用案を付記 |
| ❌ 不採用 | 意図的に外している or 不要 |

---

### 1-A 権限モデル (`permissions`)

| 機能 | 状態 | 実機確認箇所 |
|------|------|-------------|
| `defaultMode: bypassPermissions` | ✅ 使用中 | `.claude/settings.json` |
| `permissions.deny` (25件) | ✅ 使用中 | git push --force系, gh pr merge, .env編集, /opt書き込み等 |
| `permissions.allow` (314件) | ✅ 使用中 | `.claude/settings.local.json` (gitignored) |
| 広域 allow パターン (`Bash(bash:*)`, `Bash(git:*)`, `Bash(ssh:*)`, `Bash(pnpm:*)` 等) | ✅ 使用中 | settings.local.json 246 Bash パターン中 |
| MCP ツール個別 allow | ✅ 使用中 | mcp__claude_ai_Asana__*, mcp__claude_ai_Slack__*, mcp__TestSprite__* 等 68件 |

> **Deny リスト実態**: `Edit(.claude/settings.json)` と `Write(.claude/settings.json)` を deny しているため、project settings 自体はセルフ書き換え不可 (safety lock)。`Edit(SCRIPTS/24h-mode-on.sh)` / `Edit(SCRIPTS/24h-mode-off.sh)` も deny 済みで 24h モード ON/OFF を self-modify 禁止。

---

### 1-B フック (`hooks`)

| フック種別 | 設定内容 | 状態 |
|-----------|---------|------|
| `SessionStart` | `.wolf/hooks/session-start.js` (timeout 5s) | ✅ 使用中 |
| `PreToolUse (Read)` | `.wolf/hooks/pre-read.js` (timeout 5s) | ✅ 使用中 |
| `PreToolUse (Write\|Edit\|MultiEdit)` | `.wolf/hooks/pre-write.js` (timeout 5s) + deploy_guard.py ※ | ✅ 使用中 |
| `PostToolUse (Read)` | `.wolf/hooks/post-read.js` (timeout 5s) | ✅ 使用中 |
| `PostToolUse (Write\|Edit\|MultiEdit)` | `.wolf/hooks/post-write.js` (timeout 10s) | ✅ 使用中 |
| `Stop` | `.wolf/hooks/stop.js` (timeout 10s) | ✅ 使用中 |
| `SubagentStop` | — | 🔶 未活用 — サブエージェント完了時通知に使える |
| `PreCompact` | — | 🔶 未活用 — コンテキスト圧縮前にサマリ自動保存できる |

※ `deploy_guard.py` は `.claude/hooks/` に存在し、24h モード中の危険操作をブロック。settings.json の PreToolUse には Wolf hooks 経由で呼ばれる構造。

---

### 1-C カスタムエージェント (`.claude/agents/`)

| エージェント | モデル | effort | 用途 | 状態 |
|------------|-------|--------|------|------|
| `gate-runner` | claude-sonnet-4-6 | high | Gate 1→1.5→2→3 一括実行 | ✅ 使用中 |
| `cleanup` | claude-sonnet-4-6 | high | dead exports / any型 / as any 除去 | ✅ 使用中 |
| `test-writer` | claude-sonnet-4-6 | high | TEST_DEPLOY_GATE.md 準拠テスト作成 | ✅ 使用中 |
| `deploy-checker` | claude-sonnet-4-6 | medium | VPS デプロイ前後チェックリスト | ✅ 使用中 |
| `haiku` 特化エージェント (軽量調査) | — | — | — | 🔶 未活用 — 安いコストで grep / read 専用 agent を作れる |

呼び出し方: `@gate-runner` / `@cleanup` / `@test-writer` / `@deploy-checker`

---

### 1-D カスタムスキル (`.claude/skills/`)

実機確認: 24 ファイル存在。

**R2C 固有**
- `r2c-deploy-prompt`, `r2c-gentle-error`, `r2c-modal-pattern`, `r2c-tenant-isolation`, `r2c-test-rule`, `deploy-gate`, `health`

**UI / デザイン**
- `r2c-modal-pattern`, `styling-material`, `crafting-physics`, `animating-motion`, `applying-behavior`, `artisan-identity`, `artisan-schemas`, `artisan-CLAUDE.md`, `analyzing-feedback`, `decomposing-feel`, `distilling-components`, `envisioning-direction`, `inscribing-taste`, `iterating-visuals`, `rams`, `surveying-patterns`, `synthesizing-taste`

**その他**
- `next-best-practices`

スキル呼び出し: `/r2c-deploy-prompt` など `/` + スキル名。

---

### 1-E カスタムルール (`.claude/rules/`)

| ファイル | 内容 | 状態 |
|---------|------|------|
| `openwolf.md` | OpenWolf コンテキスト管理 (anatomy/cerebrum/buglog 更新義務) | ✅ 使用中 |
| テスト / セキュリティ専用ルール | — | 🔶 未活用 — `rules/test-conventions.md` で per-rules テスト規約を分離できる |

---

### 1-F グローバル設定 (`~/.claude/settings.json`)

| 機能 | 値 | 状態 |
|------|---|------|
| `model` | `"sonnet"` (claude-sonnet-4-6) | ✅ 使用中 |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `"1"` | ✅ 使用中 — 並列 Lane 有効 |
| `skipDangerousModePermissionPrompt` | `true` | ✅ 使用中 |
| `remoteControlAtStartup` | `true` | ✅ 使用中 |
| `agentPushNotifEnabled` | `true` | ✅ 使用中 |
| `statusLine` | claude-hud bun スクリプト | ✅ 使用中 |
| **プラグイン** | `claude-hud`, `understand-anything`, `codex@openai-codex`, `code-review@claude-plugins-official` | ✅ 4件有効 |
| `worktree.bgIsolation` | 未設定 (= 並列 worktree 安全) | ✅ 意図的省略 |
| Extended thinking | — | 🔶 未活用 — 複雑なアーキテクチャ判断時に `--think` フラグで有効化できる |
| `--resume` (セッション再開) | — | 🔶 未活用 — コンテキスト断絶復元プロトコルと組み合わせ可 |

---

### 1-G MCP サーバー

| サーバー | 登録場所 | ツール数 | 状態 |
|---------|---------|---------|------|
| TestSprite | `.claude/settings.json` (project) | 6 (`testsprite_*`) | ✅ 使用中 |
| Asana (old) | settings.local.json | `mcp__asana__*` | ✅ 使用中 |
| Asana (claude.ai) | settings.local.json | `mcp__claude_ai_Asana__*` | ✅ 使用中 |
| Slack (claude.ai) | settings.local.json | `mcp__claude_ai_Slack__*` | ✅ 使用中 |
| Playwright | 未設定 (CLAUDE.md に手順記載) | — | 🔶 未活用 — Gate 4b/6 で `claude mcp add --scope project playwright` |

---

### 1-H コマンド (`.claude/commands/`)

実機確認: **ディレクトリなし**。R2C はスラッシュコマンドをスキル (`.claude/skills/`) で代替。

🔶 未活用 — `/命令名` で直接呼ぶ Markdown テンプレートをここに置けばスキルよりシンプル。

---

### 1-I `/usage` (トークン使用量内訳)

セッション中に `/usage` を打つと Model / Tool / Agent 別のトークン消費が確認できる。24h ループ コスト監査に有用。詳細は第4部参照。

---

## 第2部【中核】状態リアルタイム認識 — Claude.ai の認識保証

### 2-A 前提: Claude.ai の構造的制約

| 制約 | 内容 |
|------|------|
| **セッション間無記憶** | 前セッションの判断・状態を直接参照できない |
| **CLI 実機状態不可視** | gh / git / sqlite の実態を自力で読めない — Lane 経由のみ |
| **memory は要約で古びる** | auto-memory は「書いた時点の真実」。PR 番号・ブランチ名・merge 状態は特に腐りやすい |
| **1事実から先回り断定する癖** | 「#210 が merge された」→「#209 も済んだはず」と飛躍しやすい |

**実害事例 (2026-05-26)**: hkobayashi が「#209 merge済」と述べ、Claude.ai がそれを memory / 発話のみで受理し、実機確認なしに Asana を完了処理。実際は `gh pr view 209` が `state: OPEN, mergedAt: null`。課金 API anonymous アクセス穴が本番で開いたまま「完了」になった。

---

### 2-B 強制照合プロトコル (R2C セッション開始時)

**Claude.ai は判断・完了処理・deploy 指示を出す前に、必ず Lane に以下を取らせ、返答を見てから動く。**

```bash
# Lane が実行するコマンド群 (3点セット)
gh pr view <PR番号> --json state,mergedAt,title | jq '{state,mergedAt,title}'
sqlite3 ~/.claude/projects/*/queue/r2c-queue.db \
  "SELECT id,status,task_title FROM tasks WHERE status IN ('pending','running') LIMIT 10;" 2>/dev/null || echo "queue empty"
git -C ~/projects/commerce-faq-tasks worktree list
```

返答例が来るまで Claude.ai は「次の手順」を出さない (= 返答待ち宣言が必須)。

---

### 2-C 先回り禁止トリガー一覧

以下の「〜したはず」が頭に浮かった瞬間が**照合の合図**。実機確認なしで判断を出してはいけない。

| 先回り思考 | 正しい照合 |
|-----------|-----------|
| 「PR が merge されたはず」 | `gh pr view <id> --json state,mergedAt` |
| 「Asana タスクが完了のはず」 | `mcp__claude_ai_Asana__get_task` で `completed_at` 確認 |
| 「Gate が通ったはず」 | `pnpm verify` を Lane に再実行させる |
| 「deploy が完了したはず」 | `ssh root@VPS 'pm2 list'` + curl ヘルスチェック |
| 「worktree が消えているはず」 | `git worktree list` |
| 「queue が空のはず」 | sqlite3 クエリ (上記) |
| 「今日のビルドが成功しているはず」 | `gh run list --branch <branch> --limit 3` |

**特に危険: merge 承認 ≠ merge 実体**
- hkobayashi が「merge した」と言っても `mergedAt` が null の場合がある (タイミング差, 勘違い)
- Claude.ai の完了報告 / merge 判断は hkobayashi が実機で `gh pr view` を 1 度確認してから確定

---

### 2-D 人間の歯止め設計

> Claude.ai を信用しきらない設計が安全を担保する。

1. **Claude.ai の完了報告は仮定**: 「完了しました」は「Lane からの返答を見た上での私の判断」に過ぎない。hkobayashi が `gh pr view mergedAt` / curl 確認で裏取りしてから確定。
2. **Asana 完了処理は最後**: コード merge → VPS deploy → curl 確認 → その後 Asana 完了。完了処理が先行すると「穴が開いたまま完了」が発生する。
3. **3 回ルール**: 同系統のミスを 3 回繰り返したらその判断を hkobayashi が引き取る (CLAUDE.md §3 回ルール)。

---

### 2-E セッション開始チェックリスト (Claude.ai 用)

```
□ Lane に「gh pr view <今日の対象PR> --json state,mergedAt」を実行させた
□ Lane に queue pending/running を確認させた
□ Lane に git worktree list を確認させた
□ 上記3点の返答を読んだ上で、今日の作業方針を決定した
□ 「〜したはず」思考が浮かんだ場合は照合コマンドを先に出した
```

---

## 第3部 単一情報源 (Single Source of Truth)

> TODO (2026-05-27 deploy 後に肉付け予定)

### 3-A ファイル別責任範囲 (スケルトン)

| ファイル / 場所 | 正本の内容 | 更新権者 |
|---------------|-----------|---------|
| `CLAUDE.md` | 全 Lane 共通の禁止事項・ゲート条件・運用プロトコル | hkobayashi (手動) |
| `.wolf/cerebrum.md` | プロジェクト横断の AI 学習 (Key Learnings / Do-Not-Repeat) | Lane (通常セッション) / Read-Only (24h自走中) |
| `auto-memory MEMORY.md` | 腐らない罠・preference・実機確認手順 | Lane (常時書き込み可) |
| `.claude/agents/*.md` | エージェント定義 (モデル・effort・ツール) | hkobayashi |
| `.claude/skills/*.md` | スラッシュコマンド定義 | hkobayashi |
| `docs/` | 設計・Runbook・API リファレンス | Lane / hkobayashi |

### 3-B 更新規律 (スケルトン)

- CLAUDE.md にルールを先書き → MEMORY.md には「なぜ変えたか」経緯のみ
- cerebrum.md と MEMORY.md の役割混在禁止 (24h自走ルール)
- 詳細: `CLAUDE.md §auto-memory 運用ルール`

---

## 第4部 24h ループ可視化

> TODO (2026-05-27 deploy 後に肉付け予定)

### 4-A launchd 4 本 (実機確認済)

| plist | 間隔 | 役割 | ログ |
|------|------|------|------|
| `com.r2c.dispatch.plist` | 1分 | `r2c-dispatch.sh --auto` / MAX_SLOTS=3 | `launchd-dispatch.log` |
| `com.r2c.supervisor.plist` | 1分 | stuck Lane 監視 / MAX_RUN_MINUTES=45 | `launchd-supervisor.log` |
| `com.r2c.poll.plist` | 5分 | Asana poll | `launchd-poll.log` |
| `com.r2c.morning-report.plist` | 06:00 daily | Slack Block Kit + Pushover | `launchd-morning-report.log` |

全ログ: `~/.claude-r2c-config/logs/`

TCC 注意: `~/Documents` 配下は macOS Sequoia で `Operation not permitted (exit 126)` → `~/projects` 以下か Full Disk Access 付与が必要。

### 4-B 稼働確認コマンド (スケルトン)

```bash
# launchd 4 本状態
launchctl list | grep com.r2c

# queue 状態
sqlite3 ~/.claude/projects/$(ls ~/.claude/projects | grep commerce-faq)/queue/r2c-queue.db \
  "SELECT status, count(*) FROM tasks GROUP BY status;"

# Lane (worktree) 一覧
git -C ~/projects/commerce-faq-tasks worktree list

# /usage 確認 — セッション内でコスト内訳を表示
# Claude Code セッション内で: /usage
```

---

## 第5部 企画 → 実装フロー

> TODO (2026-05-27 deploy 後に肉付け予定)

### 5-A 標準フロー概要 (スケルトン)

```
[Claude.ai: 企画・判断]
  ↓ (§2-B 強制照合 — Lane に state 確認させてから)
[Asana タスク作成]
  ↓
[Lane dispatch (r2c-dispatch.sh)]
  ↓  └ worktree 分離 (git worktree add)
[実装 Lane: feature branch]
  ├ /fewer-permission-prompts (allowlist 整備)
  ├ @gate-runner (Gate 1→1.5→2→3)
  ├ @cleanup (dead code)
  ├ @test-writer (テスト追加)
  └ @deploy-checker (VPS 前後確認)
  ↓
[PR 作成 → hkobayashi merge 確認 (gh pr view mergedAt)]
  ↓
[VPS deploy: bash SCRIPTS/deploy-vps.sh]
  ↓
[curl ヘルスチェック確認]
  ↓
[Asana 完了 (deploy 確認後に初めて実施)]
```

### 5-B 第1部機能と標準フローの対応 (スケルトン)

| フェーズ | 使う機能 |
|---------|---------|
| 企画・状態確認 | §2-B 強制照合 (gh/sqlite/git worktree) |
| allowlist 整備 | `/fewer-permission-prompts` スキル |
| 実装 | `bypassPermissions` + deny list で安全自走 |
| テスト / Gate | `@gate-runner`, `@test-writer` |
| コード整理 | `@cleanup` |
| deploy 確認 | `@deploy-checker` |
| コスト監査 | `/usage` |
| PR / Asana 連携 | `mcp__claude_ai_Asana__*`, `mcp__claude_ai_Slack__*` |
| 並列 Lane | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + worktree |

---

## 付録 A — 実機照合コマンド早見表

```bash
# Claude Code バージョン確認
claude --version
# → 2.1.150 (2026-05-26 確認)

# 設定ファイル優先順位 (global → project → local)
cat ~/.claude/settings.json            # global
cat .claude/settings.json             # project (project 設定)
cat .claude/settings.local.json       # local (gitignored, 314件 allow)

# Hooks 確認
cat .claude/settings.json | python3 -c "import json,sys; d=json.load(sys.stdin); [print(k) for k in d.get('hooks',{}).keys()]"

# エージェント確認
ls .claude/agents/
head -5 .claude/agents/gate-runner.md

# スキル確認
ls .claude/skills/ | wc -l

# Worktree 確認
git worktree list

# Queue 確認
sqlite3 .claude/queue/r2c-queue.db "SELECT status, count(*) FROM tasks GROUP BY status;"
```

---

*本ドキュメントは実機照合事実のみを記載。推測・未確認事項は TODO として明示。*
*次回更新: 2026-05-27 (VPS deploy #209/#210 完了後、第3〜5部肉付け)*
