#!/usr/bin/env bash
# r2c-queue-add.sh — R2C SQLite キューに新規 task を INSERT
#
# 用途: Asana から取り込んだタスクを r2c-queue.db.tasks に追加。
#       asana_gid UNIQUE 制約により idempotent (ON CONFLICT DO NOTHING)。
#       Phase 1 Step E-C (Asana GID 1214888697569649)。
#
# 必須引数:
#   --asana-gid <gid>
#   --name <text>
#   --tier <B|A|S>
#   --task-type <skill|hook|docs|schema|api|prod_change|migration|test|other>
#
# オプション:
#   --notes <text>
#   --permalink <url>
#   --due-on <YYYY-MM-DD>
#   --model <claude-sonnet-4-6|claude-opus-4-7|claude-haiku-4-5>
#   --gate-2-5-required          gate_2_5_required=1
#   --night-mode-allowed <0|1>   default 1
#   --max-attempts <N>           default 3
#   --dry-run                    実行 SQL を stdout に出力、書き込みなし
#   -h, --help
#
# 呼び出し例:
#   bash SCRIPTS/r2c-queue-add.sh \
#     --asana-gid 1234567890 \
#     --name "Fix CORS preflight" \
#     --tier A --task-type api --gate-2-5-required

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/Documents/GitHub/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"
LOG_DIR="${LOG_DIR:-${R2C_CONFIG}/logs}"
LOG_FILE="${LOG_DIR}/queue-add.log"

ASANA_GID=""
NAME=""
TIER=""
TASK_TYPE=""
NOTES=""
PERMALINK=""
DUE_ON=""
MODEL="claude-sonnet-4-6"
GATE_2_5=0
NIGHT_MODE_ALLOWED=1
MAX_ATTEMPTS=3
DRY_RUN=0

usage() {
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --asana-gid) ASANA_GID="${2:-}"; shift 2 ;;
        --name) NAME="${2:-}"; shift 2 ;;
        --tier) TIER="${2:-}"; shift 2 ;;
        --task-type) TASK_TYPE="${2:-}"; shift 2 ;;
        --notes) NOTES="${2:-}"; shift 2 ;;
        --permalink) PERMALINK="${2:-}"; shift 2 ;;
        --due-on) DUE_ON="${2:-}"; shift 2 ;;
        --model) MODEL="${2:-}"; shift 2 ;;
        --gate-2-5-required) GATE_2_5=1; shift ;;
        --night-mode-allowed) NIGHT_MODE_ALLOWED="${2:-1}"; shift 2 ;;
        --max-attempts) MAX_ATTEMPTS="${2:-3}"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage >&2; exit 1 ;;
    esac
done

# Required-args check
for pair in "ASANA_GID:--asana-gid" "NAME:--name" "TIER:--tier" "TASK_TYPE:--task-type"; do
    var="${pair%%:*}"
    flag="${pair##*:}"
    if [ -z "${!var}" ]; then
        echo "ERROR: missing required: $flag" >&2
        exit 1
    fi
done

# Numeric guards (avoid injection via numeric args)
if ! printf '%s' "$MAX_ATTEMPTS" | grep -qE '^[0-9]+$'; then
    echo "ERROR: --max-attempts must be non-negative integer" >&2
    exit 1
fi
if [ "$NIGHT_MODE_ALLOWED" != "0" ] && [ "$NIGHT_MODE_ALLOWED" != "1" ]; then
    echo "ERROR: --night-mode-allowed must be 0 or 1" >&2
    exit 1
fi

# SQL string escape: single-quote doubling
sql_escape() {
    printf "%s" "${1//\'/\'\'}"
}

# NULL or quoted literal
sql_str_or_null() {
    if [ -z "$1" ]; then
        printf 'NULL'
    else
        printf "'%s'" "$(sql_escape "$1")"
    fi
}

ESC_GID=$(sql_escape "$ASANA_GID")
ESC_NAME=$(sql_escape "$NAME")
ESC_TIER=$(sql_escape "$TIER")
ESC_TYPE=$(sql_escape "$TASK_TYPE")
ESC_MODEL=$(sql_escape "$MODEL")
LIT_NOTES=$(sql_str_or_null "$NOTES")
LIT_LINK=$(sql_str_or_null "$PERMALINK")
LIT_DUE=$(sql_str_or_null "$DUE_ON")

SQL=$(cat <<SQL_EOF
INSERT INTO tasks (
    asana_gid, asana_name, asana_notes, asana_permalink, asana_due_on,
    tier, task_type, model,
    gate_2_5_required, max_attempts, night_mode_allowed
) VALUES (
    '${ESC_GID}', '${ESC_NAME}', ${LIT_NOTES}, ${LIT_LINK}, ${LIT_DUE},
    '${ESC_TIER}', '${ESC_TYPE}', '${ESC_MODEL}',
    ${GATE_2_5}, ${MAX_ATTEMPTS}, ${NIGHT_MODE_ALLOWED}
)
ON CONFLICT(asana_gid) DO NOTHING
RETURNING id;
SQL_EOF
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
    printf '%s\n' "-- DRY RUN against: $QUEUE_DB"
    printf '%s\n' "$SQL"
    exit 0
fi

if [ ! -f "$QUEUE_DB" ]; then
    echo "ERROR: queue DB not found: $QUEUE_DB (run r2c-queue-init.sh first)" >&2
    exit 2
fi

mkdir -p "$LOG_DIR"
log "==== r2c-queue-add.sh asana_gid=$ASANA_GID tier=$TIER type=$TASK_TYPE ===="

NEW_ID=$(sqlite3 "$QUEUE_DB" "$SQL" || true)

if [ -n "$NEW_ID" ]; then
    log "  inserted id=$NEW_ID"
    printf '%s\n' "$NEW_ID"
else
    EXISTING=$(sqlite3 "$QUEUE_DB" \
        "SELECT id FROM tasks WHERE asana_gid='${ESC_GID}';")
    log "  duplicate asana_gid; existing id=$EXISTING (no-op)"
    printf '%s\n' "$EXISTING"
fi
