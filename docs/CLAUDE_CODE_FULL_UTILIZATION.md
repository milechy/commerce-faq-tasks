# Claude Code 完全活用ガイド (R2C)

> 実機照合日: 2026-05-27 / Claude Code 2.1.150
> 全記載事実は `grep` / `cat` / `gh` / `git` / `sqlite3` で確認済み。推測禁止 (#27)。

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

> 実機照合日: 2026-05-27 / 全記載は grep・cat・sqlite3 出力に基づく。

### 3-A ファイル別責任範囲

| ファイル / 場所 | 正本の内容 | 更新権者 | 24h自走中 |
|---------------|-----------|---------|----------|
| `CLAUDE.md` | 全 Lane 共通禁止事項・ゲート条件・運用プロトコル・Anti-Slop ルール | hkobayashi (手動) | Read-Only |
| `.wolf/cerebrum.md` | Key Learnings / Do-Not-Repeat / User Preferences / Decision Log | Lane (通常セッション) | **Read-Only** |
| `.wolf/memory.md` | セッション記録 (HH:MM / description / file / outcome / ~tokens) | Lane (通常セッション) | **Read-Only** |
| `.wolf/buglog.json` | バグログ (error_message / root_cause / fix / tags) | Lane (通常セッション) | **Read-Only** |
| `.wolf/anatomy.md` | 全ファイル 2-3 行説明 + トークン見積 (1047 ファイル追跡) | Lane (通常セッション) | **Read-Only** |
| `auto-memory MEMORY.md` | 腐らない罠・preference・実機確認手順（3問フィルタ通過分のみ） | Lane (常時書き込み可) | 書き込み可 (唯一) |
| `.claude/agents/*.md` | エージェント定義 (モデル・effort・ツール・description) | hkobayashi | Read-Only |
| `.claude/skills/*.md` | スラッシュコマンド定義 (24 ファイル存在) | hkobayashi | Read-Only |
| `docs/` | 設計・Runbook・API リファレンス (107 ファイル) | Lane / hkobayashi | 書き込み可 |
| `.claude/settings.json` | project 権限・フック・MCP 設定 (deny 25件) | hkobayashi のみ (deny で自衛) | Read-Only |
| `.claude/settings.local.json` | allowlist 314件 (gitignored) | Lane / hkobayashi | 書き込み可 |

**重複・矛盾の現状と整理案**

| 重複パターン | 現状 | 提案正本 |
|------------|------|---------|
| 禁止事項が CLAUDE.md と cerebrum.md の両方にある | 発生中 (24h自走ルール等) | CLAUDE.md を正本とし、cerebrum.md には「なぜ」の経緯のみ残す |
| 運用プロトコルが docs/ と CLAUDE.md の両方にある | 24H_AUTONOMOUS_PLAYBOOK.md と CLAUDE.md が重複 | docs/ は詳細 Runbook、CLAUDE.md はサマリ + 参照リンクに限定 |
| preference が MEMORY.md と cerebrum.md 両方に書かれる | 通常セッション中に起きやすい | 通常: cerebrum.md に書き、24h自走中: MEMORY.md に書く (時間で使い分け) |

### 3-B 更新規律

1. **ルール変更は CLAUDE.md が先** → MEMORY.md / cerebrum.md には「なぜ変えたか」の経緯のみ
2. **24h自走中の書き込み先は MEMORY.md のみ** — `.wolf/` の 4 ファイルは Read-Only
3. **MEMORY.md 書き込み前 3問フィルタ**: (Q1) コードを読めば分かるか? (Q2) 2週間後も正しいか? (Q3) 次の自分が罠を踏まずに済むか?
4. **状態スナップショット/PR番号/Asana GID は MEMORY.md 禁止** — git log / gh pr view / sqlite3 が正典

詳細: `CLAUDE.md §auto-memory 運用ルール`

---

## 第4部 24h ループ可視化

> 実機照合日: 2026-05-27 / launchd plist は `SCRIPTS/launchd/` から読み出し確認済み。

### 4-A launchd 4 本 (実機確認済)

| plist | 間隔 | 実行スクリプト | 役割 | ログ (stdout/stderr) |
|------|------|-------------|------|---------------------|
| `com.r2c.dispatch.plist` | **60秒** | `r2c-dispatch.sh --auto` | `prompt_generated` タスクを Lane に払い出す。MAX_SLOTS=3。night mode 中は Tier S/A をスキップ | `launchd-dispatch.log` / `launchd-dispatch-err.log` |
| `com.r2c.supervisor.plist` | **60秒** | `r2c-supervisor.sh` | `running` 状態の Lane を監視。MAX_RUN_MINUTES=45 超過の stuck Lane を auto-retry / rollback | `launchd-supervisor.log` / `launchd-supervisor-err.log` |
| `com.r2c.poll.plist` | **300秒 (5分)** | `r2c-asana-poll.sh` | Asana project `1213607637045514` から新規タスクを queue に取り込む | `launchd-poll.log` / `launchd-poll-err.log` |
| `com.r2c.morning-report.plist` | **06:00 daily** | `r2c-morning-report.sh` | L1-L6 集計 → Slack #r2c Block Kit 投稿 + Pushover priority -2。RunAtLoad=false (load 時は即時発火しない) | `launchd-morning-report.log` / `launchd-morning-report-err.log` |

全ログ保存先: `~/.claude-r2c-config/logs/`

共通環境変数 (全 plist で注入):
- `CLAUDE_CONFIG_DIR=/Users/hkobayashi/.claude-r2c-config` — R2C 専用アカウント分離
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — 並列 Lane 有効
- `PATH=/opt/homebrew/bin:/opt/homebrew/sbin:...`

**TCC 注意 (macOS Sequoia 実機検証 2026-05-22)**: `~/Documents` 配下は `Operation not permitted (exit 126)` で launchd から読めない。対策: (a) `/bin/bash` に Full Disk Access 付与 または (b) repo を `~/projects/` 以下に配置。R2C は現在 `~/projects/commerce-faq-tasks` で稼働中。

**デプロイ方法** (hkobayashi 手動):
```bash
cp SCRIPTS/launchd/com.r2c.dispatch.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.r2c.dispatch.plist
# 他 3 本も同様
```

---

### 4-B queue (tasks テーブル) 状態マシン

Queue DB パス: `~/projects/commerce-faq-tasks/.claude/queue/r2c-queue.db`

テーブル構成 (実機 `.schema` から):
- `tasks` — タスク本体 (以下参照)
- `automation_state` — key/value ストア (mode, pause_dispatching, drained_notified_at)
- `lane_events` — タスク操作ログ (event_type, payload)

**tasks テーブル state 遷移 (CHECK 制約から実機確認)**:

```
Asana poll → [pending]
                ↓ r2c-generate-lane.sh (dispatch --auto)
         [prompt_generated]
                ↓ r2c-dispatch.sh (claude --bg 起動)
            [running] ─── 45分タイムアウト → rollbacked
                ↓ Lane 自己報告
         [pr_created] → [verify_passed] → [ready_to_merge]
                                       ↘
                              [needs_approval] / [needs_approval_critical]
                ↓ hkobayashi merge
             [merged] → [deployed] → [done]
                ↘ 失敗
             [failed] / [rollbacked] / [cancelled]
```

現在の実 DB 状態 (2026-05-27 確認):
```bash
sqlite3 ~/projects/commerce-faq-tasks/.claude/queue/r2c-queue.db \
  "SELECT DISTINCT state FROM tasks;"
# → needs_approval_critical / rollbacked / running
```

---

### 4-C 稼働確認コマンド

```bash
# ① launchd 4 本の稼働状態 (hkobayashi が実行、Lane は launchctl 操作禁止)
launchctl list | grep com.r2c

# ② queue state 集計
sqlite3 ~/projects/commerce-faq-tasks/.claude/queue/r2c-queue.db \
  "SELECT state, count(*) FROM tasks GROUP BY state ORDER BY count(*) DESC;"

# ③ human gate 待ちタスク一覧
sqlite3 ~/projects/commerce-faq-tasks/.claude/queue/r2c-queue.db \
  "SELECT id, tier, asana_name, state FROM tasks
   WHERE state IN ('needs_approval','needs_approval_critical','ready_to_merge')
   ORDER BY tier, id;"

# ④ 実行中 Lane (worktree)
git -C ~/projects/commerce-faq-tasks worktree list

# ⑤ 本日のコスト内訳 (Claude Code セッション内)
# /usage
# → Model / Tool / Agent 別消費トークンを表示

# ⑥ dispatch 手動起動 (dry-run)
bash SCRIPTS/r2c-dispatch.sh --auto --dry-run
```

**automation_state で dispatch を一時停止**:
```bash
sqlite3 ~/projects/commerce-faq-tasks/.claude/queue/r2c-queue.db \
  "UPDATE automation_state SET value='1' WHERE key='pause_dispatching';"
# 再開:
sqlite3 ~/projects/commerce-faq-tasks/.claude/queue/r2c-queue.db \
  "UPDATE automation_state SET value='0' WHERE key='pause_dispatching';"
```

---

### 4-D Lane の起動コマンド (dispatch が実際に発行するもの)

`r2c-dispatch.sh` が内部で実行する実コマンド (実機 `sed -n '181p'` 確認):

```bash
nohup bash -c "
  cd '<worktree_path>'
  export PATH='/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH'
  claude --bg \
    --name '<lane_name>' \
    --model '<resolved_model>' \
    --permission-mode '<perm_mode>' \
    --prompt-file '<prompt_path>'
" > /dev/null 2>&1 &
disown
```

- `--bg`: バックグラウンドセッション（端末を閉じても継続）
- `--name`: Agent View での Lane 識別名
- `--permission-mode`: Tier S → `default`, Tier A/B → `bypassPermissions`
- `--prompt-file`: `r2c-generate-lane.sh` が生成した Markdown ファイルへのパス

---

## 第5部 企画 → 実装フロー

> 実機照合日: 2026-05-27 / memory#17「CLI主・Claude.aiサブ体制」を実機コマンドで補強。

### 5-A 役割分担 (確定版)

| 担当 | できること | できないこと |
|------|-----------|------------|
| **Claude.ai** | 戦略立案 / Asana MCP / Phase 計画 / Gate 2.5 スコープ判断 / merge 可否 / dispatch 配分 / 1-2 行プロンプト発行 | 実機操作 (grep / git / sqlite) / launchctl / VPS SSH |
| **Claude Code CLI (Lane)** | 実装・調査・Gate 1〜3 / PR 作成 / ログ・DB 確認 / Playwright / Slack MCP 通知 | launchctl 操作 / deploy_guard ブロック対象の SSH / DB マイグレーション |
| **hkobayashi** | launchctl load/unload / DB マイグレーション / VPS 接続 / merge 最終確認 / Asana 完了確定 | — |

**Claude.ai 指示形式**: 「推奨モデルヘッダ + 1〜2 行」のみ。長文・詳細章立て禁止 (memory フィードバック確認済み)。

---

### 5-B 並列 Lane の 2 系統 (混同禁止)

| 種別 | 起動方法 | 特徴 | コスト | R2C 用途 |
|------|---------|------|--------|---------|
| **Agent View** | ① `claude agents` コマンド ② 既存セッションで左矢印 → `[New]` | worktree 自動分離 / supervisor 管理 / 端末を閉じても継続 / 全モデル使用可 | 通常 | 独立 Lane (並列タスク) — R2C の基本方針 |
| **Agent Teams** | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (設定済) + 「create an agent team」指示 | inter-agent messaging / shared task list / Opus 強制 / 実験的機能 | **3-4 倍** | cross-domain 連携が必要な場合のみ |
| **24h 自走 Lane** | `r2c-dispatch.sh` → `claude --bg --name X --model Y --permission-mode Z --prompt-file F` | nohup + disown / worktree 内に自動配置 / DB state 管理 | 通常 | 自動化ループ |

**注意**: `dispatch --model X` は疑似コマンド。UI または --bg 経由が正規起動方法。

---

### 5-C 標準フロー (企画 → Asana 完了)

```
[Claude.ai: 企画・判断]
  ├ §2-B 強制照合 — Lane に gh/sqlite/git worktree を実行させてから判断
  └ Asana タスク作成 (mcp__claude_ai_Asana__create_tasks)
        ↓
[Asana poll → queue tasks テーブル (state: pending)]
  ↓ r2c-dispatch.sh --auto (60秒ごと)
[state: prompt_generated]
  ↓ r2c-dispatch.sh → claude --bg 起動
[state: running / Agent View に Lane が出現]
        ↓
  ┌─ /fewer-permission-prompts (allowlist 整備)
  ├─ @gate-runner (Gate 1→1.5→2→3)
  │     Gate 1: pnpm verify (typecheck + test 全パス)
  │     Gate 1.5: bash SCRIPTS/dead-code-check.sh
  │     Gate 2: bash SCRIPTS/security-scan.sh
  │     Gate 3: pnpm build && cd admin-ui && pnpm build
  ├─ @cleanup (dead exports / any 型 / as any 除去)
  ├─ @test-writer (テスト追加)
  └─ @deploy-checker (VPS 前後確認)
        ↓
[PR 作成 → state: pr_created]
  ↓ hkobayashi が gh pr view mergedAt で実機確認してから merge
[state: merged → deployed → done]
  ↓
[bash SCRIPTS/deploy-vps.sh → curl ヘルスチェック]
  ↓
[Asana 完了 (deploy 確認後に初めて実施)]
```

---

### 5-D 第1部機能とフェーズの対応

| フェーズ | 使う機能 (第1部参照) |
|---------|-------------------|
| 企画・状態確認 | §2-B 強制照合 (gh / sqlite3 / git worktree) |
| allowlist 整備 | `/fewer-permission-prompts` スキル (1-D) |
| 自動化起動 | `bypassPermissions` + deny 25件 (1-A) + launchd 4本 (4-A) |
| 並列実行 | Agent View または `claude --bg` + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (1-F) |
| テスト / Gate | `@gate-runner` / `@test-writer` (1-C) |
| コード整理 | `@cleanup` (1-C) |
| deploy 確認 | `@deploy-checker` (1-C) |
| コスト監査 | `/usage` (1-I) |
| PR / Asana / Slack 連携 | `mcp__claude_ai_Asana__*` / `mcp__claude_ai_Slack__*` (1-G) |
| コード品質 Gate 2.5 | `/codex:review --base main` (Gate 2.5, docs-only はスキップ可) |

---

## 付録 A — 実機照合コマンド早見表

```bash
# Claude Code バージョン確認
claude --version
# → 2.1.150 (2026-05-26 確認)

# 設定ファイル優先順位 (global → project → local)
cat ~/.claude/settings.json            # global (model/plugins/skipDangerousModePrompt 等)
cat .claude/settings.json             # project (hooks/MCP/deny 25件)
cat .claude/settings.local.json       # local (gitignored, allow 314件)

# Hooks 確認
cat .claude/settings.json | python3 -c "import json,sys; d=json.load(sys.stdin); [print(k) for k in d.get('hooks',{}).keys()]"

# エージェント確認
ls .claude/agents/
head -5 .claude/agents/gate-runner.md

# スキル確認
ls .claude/skills/ | wc -l
# → 24

# Worktree 確認
git worktree list

# Queue 確認 (tasks テーブル)
sqlite3 .claude/queue/r2c-queue.db "SELECT state, count(*) FROM tasks GROUP BY state;"

# launchd 稼働状態 (hkobayashi のみ実行可)
launchctl list | grep com.r2c

# dispatch dry-run
bash SCRIPTS/r2c-dispatch.sh --auto --dry-run

# 24h モード確認
ls ~/.r2c-24h-mode 2>/dev/null && echo "24h ON" || echo "24h OFF"
```

---

*本ドキュメントは実機照合事実のみを記載。推測禁止 (#27)。*
*更新: 2026-05-27 (第3〜5部実機肉付け完了)*
