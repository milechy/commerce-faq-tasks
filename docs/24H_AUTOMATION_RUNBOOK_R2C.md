# 24H Continuous Autonomous Development Loop — R2C Runbook

> **派生元**: UATa (Ultra AutoTrade) `24h-automation-runbook.md` 1.0（2026-05-17 hkobayashi 作成）を R2C 用にローカライズ
> **対応 Asana**: GID `1214899583034893`（[Tier B] docs — RUNBOOK_R2C 作成）／親 `1214893855764119`
> **作成**: 2026-05-18
> **位置づけ**: Phase 1-5 子タスクの実装根拠。本書と SCRIPTS/r2c-*.sh は対で運用する。

---

## Section 0: 仕様の真実（最優先参照正本）

| 正本 | 役割 |
|---|---|
| `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` | Claude.ai 側の役割・Tier 判定 (§11)・Gate (§7)・アカウント分離 (§15)・Pushover (§16) |
| `docs/R2C_DEVELOPMENT_PLAYBOOK.md` | CLI / hkobayashi の役割分担、セッション開始プロトコル |
| `docs/VPS_OPS_GUIDE.md` | `bash SCRIPTS/deploy-vps.sh` 単独デプロイ規約 |
| `docs/TEST_DEPLOY_GATE.md` | Gate 1〜6 の発火条件 |
| `docs/SECURITY_SCAN_POLICY.md` + `docs/SECURITY_SCAN_ALLOWLIST.md` | `--admin merge` ルール、既存依存 allowlist |
| `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` | Phase 0 評価 (.wolf/hooks Option B、Cloudflare Pages 分離、CI FAIL 運用) |
| `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` | retry 戦略、Pushover priority、morning-report Block Kit |
| `docs/PHASE1_PARALLEL_WORK_RULES.md` | File Ownership / worktree 命名規約 |
| `CLAUDE.md` | CLI 常時参照ルール (Anti-Slop、deploy_guard、ブランチ規約) |

矛盾発生時は **正本を優先**し、本書側を改訂する。

---

## Section 1: UATa-R2C 差分一覧

| # | 観点 | UATa | R2C | 差分対応 |
|---|---|---|---|---|
| 1 | デプロイ対象 | 単一 VPS（オンチェーン処理ノード）| API は VPS (`api.r2c.biz` / Hetzner)、Admin UI は Cloudflare Pages (`admin.r2c.biz` auto-deploy from `main`) | Lane 内 `changedFiles` で分岐：admin-ui only → Tier B 自動完結 / API 変更 → Tier A 以上 → `bash SCRIPTS/deploy-vps.sh` (hkobayashi 手動) |
| 2 | リスク最優先項目 | mainnet wallet 不正操作（資金損失）| Supabase RLS bypass / テナント分離崩壊 / RAG コンテンツ漏洩 | Tier S 判定に「auth/middleware/RLS 変更」を追加。Gate 2.5 を `/codex:adversarial-review` 強制 |
| 3 | アカウント設定 | `CLAUDE_CONFIG_DIR=~/.claude-uata`（UATa 専用）| `CLAUDE_CONFIG_DIR=~/.claude-r2c-config`（alias `claude-r2c`、`PHASE1_ACCOUNT_MIGRATION_RUNBOOK.md`）| 2026-05-19 06:05 に hkobayashi 手動移行（Tier S）|
| 4 | Asana ターゲット | Ultra AutoTrade GID `1213916581114014` + CRITICAL parent `1214828240949752` | RAJIUCE Development GID `1213607637045514`（assignee_any=me、5 分間隔）他プロジェクトは完全無視 | poll の WHERE 句に `projects.any=1213607637045514` 固定 |
| 5 | Slack チャンネル | `#uata`（個別 webhook）| `#r2c` channel ID `C0AG07HFJTB` | `SLACK_WEBHOOK_URL` env と channel ID を bake-in |
| 6 | CI 状態 | クリーン CI 想定 | `security-scan.yml` 既存依存 29 件 (28 high + 1 critical) で常時 FAILURE | `r2c-dispatch.sh` の auto-merge は `gh pr merge --squash --admin` を強制使用、`SECURITY_SCAN_ALLOWLIST.md` の範囲内のみ |
| 7 | Codex 統合 | 内製 review 想定 | 公式 plugin `/codex:review --base main --background`（Lane では未実行、morning-report で集計 → hkobayashi 06:10-15 手動キック）| `r2c-codex-aggregator.sh` が `gate_2_5_required=true` の未 merge PR を抽出 |
| 8 | 学習ストア | UATa は独自学習層想定 | OpenWolf（`.wolf/cerebrum.md`, `buglog.json`, `token-ledger.json`）| worktree からの並列書き込みは Phase 1 T2 で stop.js が worktree 検知 → no-op early-return 実装済（`.wolf/hooks/HOOK_BEHAVIOR.md`）|
| 9 | アバター/音声 | UATa にはない | `avatar-agent/agent.py`（LiveKit + Fish Audio）| `avatar-agent/` 変更は Tier A 以上、`deploy-vps.sh` が venv 更新を内包 |
| 10 | DB migration apply | スクリプト経由想定 | hkobayashi が VPS で `psql $DATABASE_URL ...` 手動実行 | Lane は migration SQL 生成 (Tier A) で停止 → Slack 承認 (Tier S) → 手動 apply → Lane resume |
| 11 | ローンチ判断 | mainnet 公開日（固定）| 実パートナー獲得時点（動的、現状 0 件）| Lane 優先度は固定日でなく Asana `due_on` + Tier で算出 |
| 12 | morning-report 指標 | mainnet TX / 残高 等 | L1-L6: /health 稼働率、PM2 再起動、Codex Gate 2.5 通過率、Asana 期限遵守、Admin UI ログイン、Tier 2 通知 | `r2c-morning-report.sh` が L1-L6 集計 → Slack Block Kit JSON 投稿 |
| 13 | rollback 方式 | UATa: `uata-rollback-pr.sh` で git revert + Slack 通知 + postmortem 自動生成 | R2C: 同等の `r2c-cleanup.sh` で Lane 失敗時 worktree 削除 + Asana コメント追加 + Pushover priority 1 | postmortem の自動生成は v2 で検討 |

---

## Section 2: Lane 起動シーケンス（R2C 文脈）

### 前提環境

```bash
export CLAUDE_CONFIG_DIR=~/.claude-r2c-config
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
# alias claude-r2c が .zshrc で永続化済（PHASE1_ACCOUNT_MIGRATION_RUNBOOK.md）
```

### ディレクトリ構造（Phase 1 完了時）

```
~/projects/commerce-faq-tasks/
├── .claude/
│   ├── settings.json
│   ├── lane-templates/         ← Phase 1 T3 完了 (5 ファイル)
│   │   ├── tier-b-docs.md
│   │   ├── tier-b-skill.md
│   │   ├── tier-a-api.md
│   │   ├── tier-a-schema.md
│   │   └── tier-s-prod.md
│   ├── worktrees/              ← Lane Pool 用 (gitignored、PR #158)
│   │   └── lane-{N}-{slug}/
│   ├── queue/
│   │   ├── r2c-queue.db        ← SQLite キュー
│   │   └── awaiting-approval/  ← Tier S 承認待ち
│   ├── agents/                 ← gate-runner 等
│   └── hooks/                  ← deploy_guard 等
├── SCRIPTS/                    ← r2c-*.sh 16 本 (本書の対)
├── docs/24H_AUTOMATION_RUNBOOK_R2C.md  ← 本書
└── ~/Library/LaunchAgents/
    └── com.r2c.continuous-loop.plist   ← Mac launchd 永続化（Phase 4）
```

### 起動シーケンス

```
hkobayashi 06:05 朝プロトコル開始
  ↓
launchd → r2c-cron-wrapper.sh → r2c-asana-poll.sh (5 分間隔)
  ↓ Asana → r2c-queue-add.sh
queue: pending
  ↓ r2c-dispatch.sh (1 分間隔、--auto)
queue: prompt_generated
  ↓ r2c-generate-lane.sh (.claude/lane-templates/ 展開)
queue: running
  ↓ claude --bg via nohup (worktree 分離)
  ↓ /goal 達成 or 90min 超
queue: pr_created
  ↓ r2c-supervisor.sh が監視
queue: verify_passed
  ↓
  ├─ Tier B → auto-merge (--admin --squash) → queue:merged
  ├─ Tier A → queue:needs_approval → 06:10 hkobayashi 承認 → merge
  └─ Tier S → queue:needs_approval_critical → Pushover priority 1 → 06:15 claude.ai 相談 → 手動実行
```

---

## Section 3: SQLite queue schema

> **配置先**: `.claude/queue/r2c-queue.db`（gitignored、`r2c-queue-init.sh` で初期化）

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asana_gid TEXT UNIQUE NOT NULL,
    asana_name TEXT NOT NULL,
    asana_notes TEXT,
    asana_permalink TEXT,
    asana_due_on TEXT,

    tier TEXT NOT NULL CHECK (tier IN ('B','A','S')),
    task_type TEXT NOT NULL CHECK (task_type IN ('skill','hook','docs','schema','api','prod_change','migration','test','other')),
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'
        CHECK (model IN ('claude-sonnet-4-6','claude-opus-4-7','claude-haiku-4-5')),

    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
        'pending',
        'prompt_generated',
        'running',
        'pr_created',
        'verify_passed',
        'ready_to_merge',
        'needs_approval',
        'needs_approval_critical',
        'merged',
        'deployed',
        'done',
        'failed',
        'rollbacked',
        'cancelled'
    )),

    branch TEXT,
    worktree_path TEXT,
    prompt_path TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    session_id TEXT,

    gate_2_5_required INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,

    night_mode_allowed INTEGER NOT NULL DEFAULT 1 CHECK (night_mode_allowed IN (0,1)),

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_tier ON tasks(tier);
CREATE INDEX IF NOT EXISTS idx_tasks_asana_gid ON tasks(asana_gid);

CREATE TABLE IF NOT EXISTS automation_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO automation_state(key, value) VALUES
    ('mode', 'daytime'),
    ('pause_dispatching', '0'),
    ('max_slots', '5');

CREATE TABLE IF NOT EXISTS lane_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### state 遷移表

| from | to | トリガー |
|---|---|---|
| pending | prompt_generated | `r2c-generate-lane.sh` テンプレ展開 |
| prompt_generated | running | `r2c-dispatch.sh` Lane 起動 |
| running | pr_created | Lane が `gh pr create` 成功 |
| pr_created | verify_passed | Lane 内 `@gate-runner` PASS |
| verify_passed | ready_to_merge | Tier B のみ自動 |
| verify_passed | needs_approval | Tier A |
| verify_passed | needs_approval_critical | Tier S |
| ready_to_merge | merged | `gh pr merge --admin --squash` |
| needs_approval | merged | hkobayashi 朝承認 → merge |
| needs_approval_critical | merged or cancelled | claude.ai 相談後、hkobayashi 実行 |
| merged | deployed | Cloudflare auto-deploy or hkobayashi `deploy-vps.sh` |
| deployed | done | `r2c-health-check.sh` PASS + Asana close |
| any | failed | Lane エラー、attempt < 3 なら retry、超過で rollbacked |

---

## Section 4: Pushover priority マッピング

詳細は **`docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` §2** を参照（再記述しない）。

要旨:
- `2` = Critical（本番 /health 5 分連続 503、PM2 全落ち、RLS bypass 検知 等）
- `1` = High（Tier S 承認待ち、Lane 3 回連続失敗、Codex Critical 指摘）
- `0` = Normal（Tier A 承認待ち、Lane 1-2 回失敗、Gate 2.5 Major 指摘）
- `-1` = Low（Tier B auto-merge 成功、Cloudflare auto-deploy 成功）
- `-2` = Lowest（daily morning report、週次 KPI サマリ）

`r2c-pushover.sh` がこのマッピングを bake-in する。

---

## Section 5: morning-report 構造

詳細は **`docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` §4**（Slack Block Kit JSON schema）を参照。

要旨:
- 06:00 cron → `r2c-morning-report.sh` 実行
- L1-L6 集計 → Slack Block Kit JSON 生成 → `#r2c` 投稿
- 承認待ち Tier S/A の Asana リンク添付
- Lane 失敗（24h 内）を末尾セクションに列挙
- Pushover priority `-2`（Lowest）で iOS にも通知

---

## Section 6: Asana 統合

| 項目 | 値 |
|---|---|
| プロジェクト GID | `1213607637045514`（RAJIUCE Development） |
| 除外 | UATa / DIA1000 等は完全無視（`projects.any` 句で固定）|
| assignee filter | `me`（hkobayashi）|
| poll 間隔 | 5 分（`r2c-asana-poll.sh` + launchd）|
| タスクテンプレ | 指示文 v1 §11 準拠（`[Tier B/A/S] <種類>: <内容> (期限YYYY-MM-DD)`）|
| custom_field | `tier` (S/A/B) + `gate_2_5_required` (bool)（Phase 1 で追加予定）|

### タスク取り込みフロー

```
r2c-asana-poll.sh
  ↓ asana API: GET /tasks?project=1213607637045514&assignee=me&completed_since=now
  ↓ 新規（asana_gid が queue に未存在）のみ抽出
  ↓ タスク名 prefix `[Tier X]` または custom_field から Tier 推定
  ↓ r2c-queue-add.sh で INSERT
queue: pending（Lane Pool 払い出し待ち）
```

---

## Section 7: Cloudflare Pages 連携（changedFiles 判別）

詳細は **`docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §4** を参照。

Lane 内の判別ロジック（`r2c-generate-lane.sh` で bake-in）:

```bash
CHANGED=$(git diff --name-only main...HEAD)

if echo "$CHANGED" | grep -qE '^src/|^avatar-agent/|^public/widget\.js'; then
  TIER_HINT="A"  # API 変更あり → deploy-vps.sh 必要 → Tier A 以上
elif echo "$CHANGED" | grep -qE '^admin-ui/'; then
  TIER_HINT="B"  # Admin UI のみ → Cloudflare auto-deploy で完結
elif echo "$CHANGED" | grep -qE '^SCRIPTS/deploy-vps\.sh|\.env|migrations/.+\.sql$'; then
  TIER_HINT="S"  # 本番影響 → Tier S
fi
```

Admin UI 変更の deploy 経路:

| 変更内容 | デプロイ手段 | Lane 操作 |
|---|---|---|
| 既存 Shadcn コンポーネント差し替え | Cloudflare auto-deploy | Tier B → auto-merge → Cloudflare が自動デプロイ（1-3 分）|
| 新規ページ・ルーティング変更 | Cloudflare auto-deploy + Gate 6 必須 | Tier A 昇格、hkobayashi 朝承認 |
| Cloudflare 環境変数変更 | Cloudflare ダッシュボード手動 | Tier S、Lane は手順書作成のみ |

---

## Section 8: deploy_guard 制約

> `.claude/hooks/deploy_guard.py` が以下をブロック:

- `ssh root@65.108.159.161 "..."` 等の SSH コマンド
- `git pull` 等のチェーンコマンド（特定条件下）

**結論**: Lane 内・CLI プロンプト内に SSH を含めない。VPS への変更は **すべて** `bash SCRIPTS/deploy-vps.sh` 経由（VPS_OPS_GUIDE.md §1）。

### DB migration 実行フロー（hkobayashi 手動）

```
1. Lane (Tier A): migration SQL ファイル作成 (`migrations/YYYYMMDD_xxx.sql`)
2. Lane: PR 作成 → Tier A 朝承認 → merge
3. Pushover priority 1 で hkobayashi に通知（"DB migration apply 待ち"）
4. hkobayashi: VPS で手動実行
   ssh root@65.108.159.161 "psql \$DATABASE_URL -f /opt/rajiuce/migrations/YYYYMMDD_xxx.sql"
5. hkobayashi: Slack で apply 完了報告
6. Lane (確認): `r2c-health-check.sh` + 確認クエリ実行 → queue:deployed
```

Lane は **SSH 経由でクエリを直接実行しない**。確認用クエリは `r2c-supervisor.sh` が API 経由（`/api/admin/...`）または別途取得した SQL コピーで実施。

---

## Section 9: CI security-scan FAIL 運用

### 背景

`.github/workflows/security-scan.yml` が既存依存（minimatch/protobufjs/handlebars 等 29 件、`docs/SECURITY_SCAN_ALLOWLIST.md`）で常時 FAILURE。標準の `gh pr merge --auto --squash` では緑待ちでデッドロック。

### Lane の auto-merge ルール（`r2c-dispatch.sh` 内）

```bash
PR_NUM=$1
TIER=$2

if [ "$TIER" = "B" ]; then
  # ALLOWLIST 範囲内かを check（新規 High/Critical でないことを確認）
  if bash SCRIPTS/check-existing-deps-fail.sh "$PR_NUM"; then
    gh pr merge "$PR_NUM" --squash --delete-branch --admin
  else
    # 新規 High/Critical 検出 → Tier S 格上げ
    r2c-queue-update.sh --task-id "$TASK_ID" --state needs_approval_critical
    r2c-pushover.sh --priority 1 --summary "新規 High/Critical 検出 → Tier S 格上げ" --task-id "$TASK_ID"
  fi
else
  # Tier A/S は朝承認待ち
  r2c-queue-update.sh --task-id "$TASK_ID" --state needs_approval
fi
```

### ALLOWLIST 月次レビュー

毎月第 1 金曜に claude.ai 主導で `pnpm audit` と `docs/SECURITY_SCAN_ALLOWLIST.md` を突き合わせ、解消済みエントリを削除。期限 2026-09-30 までに全件解消を目標。

---

## Section 10: Codex Gate 2.5 統合

### Lane では Codex を起動しない

Codex の `/codex:review --base main --background` は対話的セッション専用で、background 内の background プロセスは安定性が低い。Lane は PR 作成までで停止し、Codex 起動は **hkobayashi が朝プロトコル枠で実行**。

### ハンドオフ

```
Lane 完了 (Gate 1-3 PASS、PR open)
  ↓ Tier A/S は強制で gate_2_5_required=true セット
  ↓ Tier B は changedFiles 判別:
  ↓   typo / docs only / CSS only / test code only → false (skip 可)
  ↓   それ以外 → true
queue:pr_created (gate_2_5_required=true)
  ↓
morning-report (06:00) → r2c-codex-aggregator.sh
  ↓ 未 merge かつ gate_2_5_required=true の PR を抽出
  ↓ Slack Block Kit に "Gate 2.5 待ち" セクション追加
hkobayashi @ 06:10-06:15
  ↓ /codex:review --base main --background （各 PR で実行）
  ↓ /codex:result 確認
  ↓ Critical/High なし → /merge (or gh pr merge --admin)
  ↓ Critical/High あり → r2c-queue-update.sh --state failed → Lane 再起動 (修正ループ)
```

### セキュリティ変更時の adversarial-review 強制

Lane の changedFiles に以下を含む場合、`gate_2_5_required=true` + Slack には "adversarial-review 推奨" マーク:

- `src/middleware/auth*`
- `src/middleware/tenantContext*`
- `src/middleware/securityPolicy*`
- `src/api/admin/auth*`
- `migrations/*.sql`（RLS 関連）

---

## 改訂履歴

| バージョン | 日付 | 変更点 | Asana |
|---|---|---|---|
| v1 | 2026-05-18 | 初版（UATa 1.0 ベース、Phase 0/1 成果物を統合）| GID 1214899583034893 |

> 次の改訂候補（v2）: Phase 2 (Lane Pool / auto-merge 実装) 完了後 / 実パートナー獲得後 / UATa v2 (5/31 公開予定) 取り込み後。
