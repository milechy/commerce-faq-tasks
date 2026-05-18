#!/usr/bin/env bash
# r2c-dispatch.sh
# 用途: prompt_generated 状態のタスクを Lane (claude --bg) に dispatch する。
#       --auto モード (cron) は空き slot に Tier 優先で投入。
#       night mode 中は Tier S/A を投入しない。
# Cron 間隔: */1 * * * *  (--auto)
# 必要環境変数:
#   ${R2C_CONFIG}/secrets/r2c-loop.env から読込 (Asana token 等は使わないが PATH 系を継承)
# 呼び出し例:
#   bash SCRIPTS/r2c-dispatch.sh --auto
#   bash SCRIPTS/r2c-dispatch.sh --task-id 42
#   bash SCRIPTS/r2c-dispatch.sh --auto --dry-run
#
# Phase 1 Step E-A — docs/24H_AUTOMATION_RUNBOOK_R2C.md 参照。

set -euo pipefail

# ─── R2C 定数 ─────────────────────────────────────────────────────────────
R2C_ROOT="${R2C_ROOT:-$HOME/Documents/GitHub/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${R2C_ROOT}/.claude/queue/r2c-queue.db"
WORKTREE_BASE="${R2C_ROOT}/.claude/worktrees"
LOG_DIR="${R2C_CONFIG}/logs"
SCRIPT_NAME="$(basename "$0" .sh)"
MAX_SLOTS=5

# ─── 引数 ──────────────────────────────────────────────────────────────────
TASK_ID=""
AUTO_MODE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --task-id) TASK_ID="$2"; shift 2 ;;
        --auto)    AUTO_MODE=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [ -z "$TASK_ID" ] && [ "$AUTO_MODE" -eq 0 ]; then
    echo "Usage: $0 --task-id <id> | --auto [--dry-run]" >&2
    exit 1
fi

mkdir -p "$LOG_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

# shellcheck disable=SC1091
source "${R2C_CONFIG}/secrets/r2c-loop.env" 2>/dev/null || true

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-dispatch start (auto=${AUTO_MODE} task=${TASK_ID:-NA} dry=${DRY_RUN}) ==="

if [ ! -f "$QUEUE_DB" ]; then
    echo "ERROR: Queue DB not found: $QUEUE_DB" >&2
    exit 1
fi

# ─── ヘルパー ─────────────────────────────────────────────────────────────
SQ() { sqlite3 "$QUEUE_DB" "$1"; }

# ─── 自動 mode の前段チェック ────────────────────────────────────────────
CURRENT_MODE=$(SQ "SELECT value FROM automation_state WHERE key = 'mode';" || true)
PAUSE=$(SQ "SELECT value FROM automation_state WHERE key = 'pause_dispatching';" || true)

if [ "${PAUSE:-0}" = "1" ]; then
    if [ "$AUTO_MODE" -eq 1 ]; then
        exit 0
    fi
    echo "Dispatching is paused. Resume: sqlite3 ${QUEUE_DB} \"UPDATE automation_state SET value='0' WHERE key='pause_dispatching';\""
    exit 0
fi

ACTIVE_COUNT=$(SQ "SELECT COUNT(*) FROM tasks WHERE state = 'running';")
ACTIVE_COUNT=${ACTIVE_COUNT:-0}
AVAILABLE_SLOTS=$((MAX_SLOTS - ACTIVE_COUNT))

if [ "$AUTO_MODE" -eq 1 ] && [ "$AVAILABLE_SLOTS" -le 0 ]; then
    echo "No free slots (active=${ACTIVE_COUNT}/${MAX_SLOTS}), skipping cycle"
    exit 0
fi

# ─── auto mode: dispatch 候補抽出 ────────────────────────────────────────
NIGHT_FILTER=""
if [ "${CURRENT_MODE:-day}" = "night" ]; then
    NIGHT_FILTER="AND night_mode_allowed = 1 AND tier = 'B'"
fi

dispatch_one() {
    local task_id="$1"

    local task_data
    task_data=$(SQ "SELECT asana_gid, asana_name, tier, task_type, prompt_path, state, model FROM tasks WHERE id = ${task_id};") || true
    if [ -z "$task_data" ]; then
        echo "ERROR: Task ${task_id} not found"
        return 1
    fi

    local asana_gid name tier task_type prompt_path state model
    IFS='|' read -r asana_gid name tier task_type prompt_path state model <<< "$task_data"
    echo "  asana_gid=${asana_gid} tier=${tier} type=${task_type}"

    if [ "$state" != "prompt_generated" ]; then
        echo "ERROR: Task ${task_id} state='${state}', expected 'prompt_generated'"
        return 1
    fi

    if [ -z "$prompt_path" ] || [ ! -f "$prompt_path" ]; then
        echo "ERROR: prompt_path missing for task ${task_id}: ${prompt_path}"
        return 1
    fi

    local slug
    slug=$(echo "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
    [ -z "$slug" ] && slug="task"
    local worktree_path="${WORKTREE_BASE}/lane-${task_id}-${slug}"
    local branch_name="auto/${tier,,}-${task_id}-${slug}"
    local log_file="${LOG_DIR}/lane-${task_id}.log"
    local lane_name="auto-${tier,,}-${task_id}"
    local perm_mode="acceptEdits"
    case "$tier" in
        A) perm_mode="plan" ;;
        S) perm_mode="plan" ;;
    esac
    local resolved_model="${model:-claude-sonnet-4-6}"

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "DRY-RUN: would dispatch task=${task_id} tier=${tier} type=${task_type}"
        echo "  worktree=${worktree_path}"
        echo "  branch=${branch_name}"
        echo "  model=${resolved_model} perm=${perm_mode}"
        echo "  prompt=${prompt_path}"
        return 0
    fi

    if [ ! -d "$worktree_path" ]; then
        (
            cd "$R2C_ROOT"
            git fetch origin main 2>&1 | tail -3 || true
            if git show-ref --verify --quiet "refs/heads/${branch_name}"; then
                git worktree add "$worktree_path" "$branch_name"
            else
                git worktree add -b "$branch_name" "$worktree_path" origin/main
            fi
        ) || {
            echo "ERROR: git worktree add failed for task ${task_id}"
            SQ "UPDATE tasks SET state='failed', error_message='worktree add failed', last_action='dispatch_abort' WHERE id = ${task_id};"
            return 1
        }
    fi

    SQ "UPDATE tasks SET state='running', worktree_path='${worktree_path}', branch='${branch_name}', started_at=datetime('now'), attempt_count=COALESCE(attempt_count,0)+1, last_action='dispatched' WHERE id = ${task_id};"

    mkdir -p "$(dirname "$log_file")"

    nohup bash -c "
        cd '${worktree_path}'
        export PATH='/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:\$PATH'
        claude --bg --name '${lane_name}' \\
            --model '${resolved_model}' \\
            --permission-mode '${perm_mode}' \\
            --prompt-file '${prompt_path}' > '${log_file}' 2>&1
    " > /dev/null 2>&1 &
    disown

    echo "Dispatched task ${task_id} (lane=${lane_name}) → ${log_file}"
    return 0
}

if [ "$AUTO_MODE" -eq 1 ]; then
    SLOTS_USED=0
    while [ "$SLOTS_USED" -lt "$AVAILABLE_SLOTS" ]; do
        NEXT_ID=$(SQ "SELECT id FROM tasks
                      WHERE state = 'prompt_generated' ${NIGHT_FILTER}
                      ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 ELSE 2 END,
                               COALESCE(asana_due_on, '9999-12-31') ASC,
                               id ASC
                      LIMIT 1;")
        if [ -z "$NEXT_ID" ]; then
            echo "No more prompt_generated tasks (slots used=${SLOTS_USED}/${AVAILABLE_SLOTS})"
            break
        fi
        if dispatch_one "$NEXT_ID"; then
            SLOTS_USED=$((SLOTS_USED + 1))
        else
            echo "WARNING: dispatch_one failed for ${NEXT_ID}, continuing"
        fi
    done
else
    dispatch_one "$TASK_ID"
fi

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-dispatch done ==="
echo ""
