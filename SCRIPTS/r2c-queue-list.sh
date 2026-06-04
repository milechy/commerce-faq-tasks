#!/usr/bin/env bash
# r2c-queue-list.sh — R2C SQLite キューの task を一覧表示 (読み取り専用)
#
# 用途: state / tier / asana_gid でフィルタして tasks 一覧を出力。
#       human (table) / json / tsv の 3 フォーマット対応。
#       Phase 1 Step E-C (Asana GID 1214888697569649)。
#
# オプション:
#   --state <csv>          例: pending,running  (省略時=全state)
#   --tier <B|A|S>
#   --asana-gid <gid>
#   --limit <N>            default 20
#   --format <human|json|tsv>   default human
#   --with-events          json mode のみ。lane_events を埋め込む
#   -h, --help
#
# 呼び出し例:
#   bash SCRIPTS/r2c-queue-list.sh
#   bash SCRIPTS/r2c-queue-list.sh --state pending,running --tier A
#   bash SCRIPTS/r2c-queue-list.sh --format json | jq '.[] | .id'

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"

STATE_CSV=""
TIER=""
ASANA_GID=""
LIMIT=20
FORMAT="human"
WITH_EVENTS=0

usage() {
    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --state) STATE_CSV="${2:-}"; shift 2 ;;
        --tier) TIER="${2:-}"; shift 2 ;;
        --asana-gid) ASANA_GID="${2:-}"; shift 2 ;;
        --limit) LIMIT="${2:-20}"; shift 2 ;;
        --format) FORMAT="${2:-human}"; shift 2 ;;
        --with-events) WITH_EVENTS=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage >&2; exit 1 ;;
    esac
done

if ! printf '%s' "$LIMIT" | grep -qE '^[0-9]+$'; then
    echo "ERROR: --limit must be non-negative integer" >&2
    exit 1
fi
case "$FORMAT" in
    human|json|tsv) ;;
    *) echo "ERROR: --format must be human|json|tsv" >&2; exit 1 ;;
esac

if [ ! -f "$QUEUE_DB" ]; then
    echo "ERROR: queue DB not found: $QUEUE_DB (run r2c-queue-init.sh first)" >&2
    exit 2
fi

sql_escape() {
    printf "%s" "${1//\'/\'\'}"
}

# Build WHERE
WHERE_PARTS=()
if [ -n "$STATE_CSV" ]; then
    IN_LIST=""
    IFS=',' read -ra ARR <<< "$STATE_CSV"
    for s in "${ARR[@]}"; do
        s_trim="${s// /}"
        [ -z "$s_trim" ] && continue
        esc=$(sql_escape "$s_trim")
        if [ -z "$IN_LIST" ]; then
            IN_LIST="'${esc}'"
        else
            IN_LIST="${IN_LIST},'${esc}'"
        fi
    done
    if [ -n "$IN_LIST" ]; then
        WHERE_PARTS+=("state IN (${IN_LIST})")
    fi
fi
if [ -n "$TIER" ]; then
    WHERE_PARTS+=("tier='$(sql_escape "$TIER")'")
fi
if [ -n "$ASANA_GID" ]; then
    WHERE_PARTS+=("asana_gid='$(sql_escape "$ASANA_GID")'")
fi

WHERE_CLAUSE=""
for w in "${WHERE_PARTS[@]:-}"; do
    [ -z "$w" ] && continue
    if [ -z "$WHERE_CLAUSE" ]; then
        WHERE_CLAUSE="WHERE $w"
    else
        WHERE_CLAUSE="${WHERE_CLAUSE} AND $w"
    fi
done

COLS="id, asana_gid, asana_name, tier, task_type, state, attempt_count, created_at, pr_number, pr_url"
BASE_SQL="SELECT ${COLS} FROM tasks ${WHERE_CLAUSE} ORDER BY id DESC LIMIT ${LIMIT};"

case "$FORMAT" in
    human)
        # Pipe-separated for safe parsing, then awk format
        printf 'id\tgid\tname\ttier\ttype\tstate\tattempt\tcreated\n'
        printf '%s\n' "----"
        sqlite3 -separator $'\t' "$QUEUE_DB" \
            "SELECT id, asana_gid, substr(asana_name,1,40), tier, task_type, state, attempt_count, created_at FROM tasks ${WHERE_CLAUSE} ORDER BY id DESC LIMIT ${LIMIT};" \
            | awk -F'\t' 'BEGIN{OFS="\t"} {print $1,$2,$3,$4,$5,$6,$7,$8}'
        ;;
    tsv)
        sqlite3 -separator $'\t' "$QUEUE_DB" "$BASE_SQL"
        ;;
    json)
        # Use sqlite3's -json (available in modern sqlite3 >=3.33)
        TASKS_JSON=$(sqlite3 -json "$QUEUE_DB" "$BASE_SQL" 2>/dev/null || true)
        if [ -z "$TASKS_JSON" ]; then
            TASKS_JSON="[]"
        fi
        if [ "$WITH_EVENTS" -eq 1 ]; then
            if ! command -v jq > /dev/null 2>&1; then
                echo "ERROR: --with-events requires jq" >&2
                exit 1
            fi
            EVENTS_JSON=$(sqlite3 -json "$QUEUE_DB" \
                "SELECT task_id, event_type, payload, created_at FROM lane_events WHERE task_id IN (SELECT id FROM tasks ${WHERE_CLAUSE} ORDER BY id DESC LIMIT ${LIMIT}) ORDER BY id ASC;" \
                2>/dev/null || true)
            [ -z "$EVENTS_JSON" ] && EVENTS_JSON="[]"
            printf '%s' "$TASKS_JSON" | jq --argjson ev "$EVENTS_JSON" \
                'map(. as $t | . + {events: ($ev | map(select(.task_id == $t.id)))})'
        else
            printf '%s\n' "$TASKS_JSON"
        fi
        ;;
esac
