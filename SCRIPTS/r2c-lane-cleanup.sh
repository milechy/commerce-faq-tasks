#!/usr/bin/env bash
# r2c-lane-cleanup.sh — Lane 単位の worktree + ローカルブランチ削除 (R2C 24h loop)
#
# 用途:
#   - r2c-supervisor.sh から stuck Lane の rollback 時に呼ばれる
#   - queue から worktree_path / branch / session_id を取得 → プロセス kill + worktree 削除
#   - best-effort (各ステップ独立で || true、失敗しても続行)
#
# 環境変数:
#   R2C_ROOT, R2C_CONFIG, QUEUE_DB, WORKTREE_BASE, LOG_DIR
#
# 呼び出し例:
#   bash SCRIPTS/r2c-lane-cleanup.sh --task-id 42
#   bash SCRIPTS/r2c-lane-cleanup.sh --task-id 42 --dry-run

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/Documents/GitHub/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"
WORKTREE_BASE="${WORKTREE_BASE:-${R2C_ROOT}/.claude/worktrees}"
LOG_DIR="${LOG_DIR:-${R2C_CONFIG}/logs}"

TASK_ID=""
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --task-id) TASK_ID="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        *)         echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [ -z "${TASK_ID}" ]; then
    echo "ERROR: --task-id required" >&2
    exit 1
fi

# 数値 validation (SQL injection 防御)
if ! [[ "${TASK_ID}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: --task-id must be numeric" >&2
    exit 1
fi

mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/lane-cleanup.log"
if [ "${DRY_RUN}" -eq 0 ]; then
    exec >> "${LOG_FILE}" 2>&1
fi

# shellcheck disable=SC1091
source "${R2C_CONFIG}/secrets/r2c-loop.env" 2>/dev/null || true

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === lane-cleanup task_id=${TASK_ID} dry-run=${DRY_RUN} ==="

if [ ! -f "${QUEUE_DB}" ]; then
    echo "ERROR: queue db not found: ${QUEUE_DB}" >&2
    exit 1
fi

# queue から情報取得
ROW=$(sqlite3 -separator $'\t' "${QUEUE_DB}" "SELECT IFNULL(worktree_path,''), IFNULL(branch,''), IFNULL(session_id,'') FROM tasks WHERE id=${TASK_ID};")
if [ -z "${ROW}" ]; then
    echo "ERROR: task id ${TASK_ID} not found in queue" >&2
    exit 1
fi

WORKTREE_PATH=$(echo "${ROW}" | cut -f1)
BRANCH=$(echo "${ROW}" | cut -f2)
SESSION_ID=$(echo "${ROW}" | cut -f3)

echo "  worktree_path: ${WORKTREE_PATH:-<none>}"
echo "  branch:        ${BRANCH:-<none>}"
echo "  session_id:    ${SESSION_ID:-<none>}"

# 1. プロセス kill (session_id があれば)
if [ -n "${SESSION_ID}" ]; then
    if [ "${DRY_RUN}" -eq 1 ]; then
        echo "  [dry-run] would pkill -f 'claude.*${SESSION_ID}'"
    else
        pkill -f "claude.*${SESSION_ID}" 2>/dev/null || true
        echo "  pkill claude session done"
    fi
fi

# 2. worktree 削除 (WORKTREE_BASE prefix check で safety)
if [ -n "${WORKTREE_PATH}" ]; then
    case "${WORKTREE_PATH}" in
        "${WORKTREE_BASE}"/*)
            if [ "${DRY_RUN}" -eq 1 ]; then
                echo "  [dry-run] would git worktree remove --force ${WORKTREE_PATH}"
            else
                (cd "${R2C_ROOT}" && git worktree remove --force "${WORKTREE_PATH}" 2>&1) || echo "  WARN: worktree remove failed"
            fi
            ;;
        *)
            echo "  REJECT worktree (not under WORKTREE_BASE): ${WORKTREE_PATH}"
            ;;
    esac
fi

# 3. branch 削除
if [ -n "${BRANCH}" ]; then
    if [ "${DRY_RUN}" -eq 1 ]; then
        echo "  [dry-run] would git branch -D ${BRANCH}"
    else
        (cd "${R2C_ROOT}" && git branch -D "${BRANCH}" 2>&1) || echo "  WARN: branch -D failed (may not exist or be current)"
    fi
fi

# 4. lane_events 記録
if [ "${DRY_RUN}" -eq 0 ]; then
    sqlite3 "${QUEUE_DB}" "INSERT INTO lane_events(task_id, event_type, payload) VALUES(${TASK_ID}, 'lane_cleanup', '{\"by\":\"r2c-lane-cleanup.sh\"}');" || true
fi

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === lane-cleanup done ==="
