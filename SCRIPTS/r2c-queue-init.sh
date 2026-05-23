#!/usr/bin/env bash
# r2c-queue-init.sh — R2C 24h Autonomous Loop: SQLite キュー DB 初期化
#
# 用途: .claude/queue/r2c-queue.db の schema を作成/更新 (idempotent)。
#       Phase 1 Step E-C (Asana GID 1214888697569649)。
#
# 必須引数: なし
# オプション:
#   --reset      既存 DB を timestamp 付き .bak に退避してから再作成
#   --dry-run    実行 SQL を stdout に出力するだけ (書き込みなし)
#   -h, --help   ヘルプ表示
#
# 呼び出し例:
#   bash SCRIPTS/r2c-queue-init.sh
#   bash SCRIPTS/r2c-queue-init.sh --reset
#   bash SCRIPTS/r2c-queue-init.sh --dry-run

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/Documents/GitHub/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"
LOG_DIR="${LOG_DIR:-${R2C_CONFIG}/logs}"
LOG_FILE="${LOG_DIR}/queue-init.log"

DRY_RUN=0
RESET=0

usage() {
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --reset) RESET=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage >&2; exit 1 ;;
    esac
done

SCHEMA_SQL=$(cat <<'SQL'
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
        'pending','prompt_generated','running','pr_created','verify_passed',
        'ready_to_merge','needs_approval','needs_approval_critical',
        'merged','deployed','done','failed','rollbacked','cancelled'
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
    -- dispatch / supervisor が遷移ごとに記録する運用列 (手動 ALTER を schema 化し --reset で消えないように)
    last_action TEXT,
    error_message TEXT,
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
SQL
)

log() {
    local msg
    msg="[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
    printf '%s\n' "$msg"
    if [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "$LOG_DIR"
        printf '%s\n' "$msg" >> "$LOG_FILE"
    fi
}

if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' "-- DRY RUN: would init DB at: $QUEUE_DB"
    if [ "$RESET" -eq 1 ] && [ -f "$QUEUE_DB" ]; then
        printf '%s\n' "-- DRY RUN: would mv $QUEUE_DB -> $QUEUE_DB.bak.YYYYMMDD_HHMMSS"
    fi
    printf '%s\n' "$SCHEMA_SQL"
    printf '%s\n' "-- DRY RUN: would run PRAGMA integrity_check"
    exit 0
fi

mkdir -p "$(dirname "$QUEUE_DB")"
mkdir -p "$LOG_DIR"

log "==== r2c-queue-init.sh start ===="
log "QUEUE_DB=$QUEUE_DB"
log "RESET=$RESET"

if [ "$RESET" -eq 1 ] && [ -f "$QUEUE_DB" ]; then
    BAK="${QUEUE_DB}.bak.$(date +%Y%m%d_%H%M%S)"
    mv "$QUEUE_DB" "$BAK"
    log "  reset: moved existing DB to $BAK"
fi

printf '%s\n' "$SCHEMA_SQL" | sqlite3 "$QUEUE_DB"
log "  schema applied (idempotent)"

# 既存 DB への idempotent migration: CREATE TABLE IF NOT EXISTS は既存テーブルに
# 列を追加しないため、不足している運用列 (dispatch/supervisor が UPDATE する) を補う。
ensure_column() {
    local col="$1" decl="$2"
    if ! sqlite3 "$QUEUE_DB" "PRAGMA table_info(tasks);" | cut -d'|' -f2 | grep -qx "$col"; then
        sqlite3 "$QUEUE_DB" "ALTER TABLE tasks ADD COLUMN ${col} ${decl};"
        log "  migrate: added column tasks.${col}"
    fi
}
ensure_column last_action "TEXT"
ensure_column error_message "TEXT"

INTEGRITY=$(sqlite3 "$QUEUE_DB" "PRAGMA integrity_check;")
log "  PRAGMA integrity_check: $INTEGRITY"
if [ "$INTEGRITY" != "ok" ]; then
    log "ERROR: integrity_check failed"
    exit 3
fi

TASK_CNT=$(sqlite3 "$QUEUE_DB" "SELECT COUNT(*) FROM tasks;")
STATE_CNT=$(sqlite3 "$QUEUE_DB" "SELECT COUNT(*) FROM automation_state;")
log "  tasks=$TASK_CNT automation_state=$STATE_CNT"
log "==== r2c-queue-init.sh done ===="

printf '%s\n' "OK: $QUEUE_DB initialized."
