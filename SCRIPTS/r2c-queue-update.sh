#!/usr/bin/env bash
# r2c-queue-update.sh — R2C SQLite キューの task を UPDATE
#
# 用途: state 遷移 (CHECK 表に基づく) や branch / pr_number / 各種ステータス
#       フィールドを更新。state 遷移時は lane_events に履歴を追記。
#       Phase 1 Step E-C (Asana GID 1214888697569649)。
#
# 必須引数:
#   --task-id <id>
#
# 更新フィールド (1 個以上指定):
#   --state <new-state>          遷移許容表を bake-in、不正なら exit 2
#   --branch <name>
#   --worktree-path <path>
#   --prompt-path <path>
#   --pr-number <num>
#   --pr-url <url>
#   --session-id <sid>
#   --attempt-inc                attempt_count = attempt_count + 1
#   --started                    started_at = datetime('now')
#   --completed                  completed_at = datetime('now')
#
# その他:
#   --force                      state 遷移 check を bypass
#   --dry-run                    実行 SQL を stdout に出力、書き込みなし
#   -h, --help
#
# 呼び出し例:
#   bash SCRIPTS/r2c-queue-update.sh --task-id 42 --state running --started
#   bash SCRIPTS/r2c-queue-update.sh --task-id 42 --pr-number 999 --pr-url https://...

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"
LOG_DIR="${LOG_DIR:-${R2C_CONFIG}/logs}"
LOG_FILE="${LOG_DIR}/queue-update.log"

TASK_ID=""
NEW_STATE=""
BRANCH=""
WORKTREE_PATH=""
PROMPT_PATH=""
PR_NUMBER=""
PR_URL=""
SESSION_ID=""
ATTEMPT_INC=0
SET_STARTED=0
SET_COMPLETED=0
FORCE=0
DRY_RUN=0

# Sentinels (so we can distinguish "not provided" from "empty value")
HAS_BRANCH=0
HAS_WORKTREE=0
HAS_PROMPT=0
HAS_PR_NUMBER=0
HAS_PR_URL=0
HAS_SESSION=0

usage() {
    sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --task-id) TASK_ID="${2:-}"; shift 2 ;;
        --state) NEW_STATE="${2:-}"; shift 2 ;;
        --branch) BRANCH="${2:-}"; HAS_BRANCH=1; shift 2 ;;
        --worktree-path) WORKTREE_PATH="${2:-}"; HAS_WORKTREE=1; shift 2 ;;
        --prompt-path) PROMPT_PATH="${2:-}"; HAS_PROMPT=1; shift 2 ;;
        --pr-number) PR_NUMBER="${2:-}"; HAS_PR_NUMBER=1; shift 2 ;;
        --pr-url) PR_URL="${2:-}"; HAS_PR_URL=1; shift 2 ;;
        --session-id) SESSION_ID="${2:-}"; HAS_SESSION=1; shift 2 ;;
        --attempt-inc) ATTEMPT_INC=1; shift ;;
        --started) SET_STARTED=1; shift ;;
        --completed) SET_COMPLETED=1; shift ;;
        --force) FORCE=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage >&2; exit 1 ;;
    esac
done

if [ -z "$TASK_ID" ]; then
    echo "ERROR: --task-id is required" >&2
    exit 1
fi
if ! printf '%s' "$TASK_ID" | grep -qE '^[0-9]+$'; then
    echo "ERROR: --task-id must be positive integer" >&2
    exit 1
fi
if [ -n "$PR_NUMBER" ] && ! printf '%s' "$PR_NUMBER" | grep -qE '^[0-9]+$'; then
    echo "ERROR: --pr-number must be integer" >&2
    exit 1
fi

# Allowed transitions (terminal states: done / rollbacked / cancelled)
allowed_transition() {
    local from="$1" to="$2"
    case "$from->$to" in
        "pending->prompt_generated"|"pending->cancelled") return 0 ;;
        "prompt_generated->running"|"prompt_generated->cancelled") return 0 ;;
        "running->pr_created"|"running->failed") return 0 ;;
        "pr_created->verify_passed"|"pr_created->failed") return 0 ;;
        "verify_passed->ready_to_merge"|"verify_passed->needs_approval"|"verify_passed->needs_approval_critical"|"verify_passed->failed") return 0 ;;
        "ready_to_merge->merged"|"ready_to_merge->failed") return 0 ;;
        "needs_approval->merged"|"needs_approval->cancelled") return 0 ;;
        "needs_approval_critical->merged"|"needs_approval_critical->cancelled") return 0 ;;
        "merged->deployed"|"merged->failed") return 0 ;;
        "deployed->done"|"deployed->failed") return 0 ;;
        "failed->pending"|"failed->rollbacked") return 0 ;;
        *) return 1 ;;
    esac
}

sql_escape() {
    printf "%s" "${1//\'/\'\'}"
}

log() {
    local msg
    msg="[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
    printf '%s\n' "$msg"
    if [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "$LOG_DIR"
        printf '%s\n' "$msg" >> "$LOG_FILE"
    fi
}

# Build SET clause incrementally
SET_PARTS=()

if [ -n "$NEW_STATE" ]; then
    ESC_STATE=$(sql_escape "$NEW_STATE")
    SET_PARTS+=("state='${ESC_STATE}'")
fi
if [ "$HAS_BRANCH" -eq 1 ]; then
    SET_PARTS+=("branch='$(sql_escape "$BRANCH")'")
fi
if [ "$HAS_WORKTREE" -eq 1 ]; then
    SET_PARTS+=("worktree_path='$(sql_escape "$WORKTREE_PATH")'")
fi
if [ "$HAS_PROMPT" -eq 1 ]; then
    SET_PARTS+=("prompt_path='$(sql_escape "$PROMPT_PATH")'")
fi
if [ "$HAS_PR_NUMBER" -eq 1 ]; then
    if [ -z "$PR_NUMBER" ]; then
        SET_PARTS+=("pr_number=NULL")
    else
        SET_PARTS+=("pr_number=${PR_NUMBER}")
    fi
fi
if [ "$HAS_PR_URL" -eq 1 ]; then
    SET_PARTS+=("pr_url='$(sql_escape "$PR_URL")'")
fi
if [ "$HAS_SESSION" -eq 1 ]; then
    SET_PARTS+=("session_id='$(sql_escape "$SESSION_ID")'")
fi
if [ "$ATTEMPT_INC" -eq 1 ]; then
    SET_PARTS+=("attempt_count=attempt_count+1")
fi
if [ "$SET_STARTED" -eq 1 ]; then
    SET_PARTS+=("started_at=datetime('now')")
fi
if [ "$SET_COMPLETED" -eq 1 ]; then
    SET_PARTS+=("completed_at=datetime('now')")
fi
# Always bump updated_at
SET_PARTS+=("updated_at=datetime('now')")

if [ "${#SET_PARTS[@]}" -le 1 ]; then
    echo "ERROR: no update fields provided" >&2
    usage >&2
    exit 1
fi

# Build SET clause (comma-joined)
SET_CLAUSE=""
for p in "${SET_PARTS[@]}"; do
    if [ -z "$SET_CLAUSE" ]; then
        SET_CLAUSE="$p"
    else
        SET_CLAUSE="${SET_CLAUSE}, $p"
    fi
done

# Look up current state if we are transitioning
CUR_STATE=""
if [ -n "$NEW_STATE" ] || [ "$DRY_RUN" -eq 0 ]; then
    if [ -f "$QUEUE_DB" ]; then
        CUR_STATE=$(sqlite3 "$QUEUE_DB" \
            "SELECT state FROM tasks WHERE id=${TASK_ID};" 2>/dev/null || true)
    fi
fi

if [ -n "$NEW_STATE" ] && [ -n "$CUR_STATE" ] && [ "$FORCE" -eq 0 ]; then
    if [ "$CUR_STATE" = "$NEW_STATE" ]; then
        log "  no-op: state already '$NEW_STATE'"
    elif ! allowed_transition "$CUR_STATE" "$NEW_STATE"; then
        echo "ERROR: disallowed state transition: $CUR_STATE -> $NEW_STATE (use --force to bypass)" >&2
        exit 2
    fi
fi

UPDATE_SQL="UPDATE tasks SET ${SET_CLAUSE} WHERE id=${TASK_ID};"

EVENT_SQL=""
if [ -n "$NEW_STATE" ] && [ -n "$CUR_STATE" ] && [ "$CUR_STATE" != "$NEW_STATE" ]; then
    ESC_FROM=$(sql_escape "$CUR_STATE")
    ESC_TO=$(sql_escape "$NEW_STATE")
    PAYLOAD="{\"from\":\"${ESC_FROM}\",\"to\":\"${ESC_TO}\"}"
    ESC_PAYLOAD=$(sql_escape "$PAYLOAD")
    EVENT_SQL="INSERT INTO lane_events(task_id, event_type, payload) VALUES (${TASK_ID}, 'state_change', '${ESC_PAYLOAD}');"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' "-- DRY RUN against: $QUEUE_DB"
    printf '%s\n' "$UPDATE_SQL"
    [ -n "$EVENT_SQL" ] && printf '%s\n' "$EVENT_SQL"
    exit 0
fi

if [ ! -f "$QUEUE_DB" ]; then
    echo "ERROR: queue DB not found: $QUEUE_DB" >&2
    exit 2
fi

mkdir -p "$LOG_DIR"
log "==== r2c-queue-update.sh task_id=$TASK_ID state=$CUR_STATE->${NEW_STATE:-(no-change)} ===="

# Wrap in transaction (state-change event + tasks update atomic)
{
    printf '%s\n' "BEGIN;"
    printf '%s\n' "$UPDATE_SQL"
    [ -n "$EVENT_SQL" ] && printf '%s\n' "$EVENT_SQL"
    printf '%s\n' "COMMIT;"
} | sqlite3 "$QUEUE_DB"

CHANGED=$(sqlite3 "$QUEUE_DB" \
    "SELECT changes();" 2>/dev/null || echo "?")
log "  updated rows≈$CHANGED"
printf '%s\n' "OK: task $TASK_ID updated."
