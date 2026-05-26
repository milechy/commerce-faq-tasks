#!/usr/bin/env bash
# r2c-supervisor.sh
# 用途: 1 分間隔で稼働中 Lane を監視。90 分以上 running の stuck Lane を
#       検出して kill → attempt_count に応じて retry / rollback。
#       連続失敗の閾値超過で dispatching を pause、Pushover で通知。
# Cron 間隔: */1 * * * *
# 必要環境変数:
#   ${R2C_CONFIG}/secrets/r2c-loop.env から (Pushover token 等)
# 呼び出し例:
#   bash SCRIPTS/r2c-supervisor.sh
#   bash SCRIPTS/r2c-supervisor.sh --dry-run
#
# Phase 1 Step E-A — docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md §1 準拠。

set -uo pipefail

# ─── R2C 定数 ─────────────────────────────────────────────────────────────
R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${R2C_ROOT}/.claude/queue/r2c-queue.db"
LOG_DIR="${R2C_CONFIG}/logs"
SCRIPT_NAME="$(basename "$0" .sh)"
# UATa 3日運用教訓: 90min × MAX_ATTEMPTS(3) = 最大 4.5h の長時間 stuck が複数発生。
# 45min に短縮して最大 stuck 時間を 2.25h に圧縮する。CI 完了待ちは Lane 内の
# 20min timeout（lane-template / CLAUDE.md「CI 待ちプロトコル」参照）で別途制御。
MAX_RUN_MINUTES=45
MAX_ATTEMPTS=3
RECENT_FAILED_THRESHOLD=5
RECENT_FAILED_WINDOW="-2 hours"

# ─── 引数 ──────────────────────────────────────────────────────────────────
DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
    esac
done

mkdir -p "$LOG_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

# secrets fail-fast: 24h ループ本体は secrets 必須。silent-failure で空 token のまま
# 走ると通知不能の連鎖事故になるため、未配備/source 失敗時は即停止する。
# (注: Slack/Pushover の認証情報も secrets 内のため、未配備時の通知は stderr 止まり)
SECRETS_FILE="${R2C_CONFIG}/secrets/r2c-loop.env"
if [ ! -f "$SECRETS_FILE" ]; then
    echo "[$(date +%Y-%m-%d_%H:%M:%S)] FATAL: secrets not found: ${SECRETS_FILE} — 配備後に再実行" >&2
    bash "${R2C_ROOT}/SCRIPTS/notify-slack.sh" "🛑 r2c-supervisor: secrets 未配備で起動中止 (${SECRETS_FILE})" --color error 2>/dev/null || true
    exit 1
fi
# shellcheck disable=SC1090,SC1091
source "$SECRETS_FILE" || {
    echo "[$(date +%Y-%m-%d_%H:%M:%S)] FATAL: failed to source secrets: ${SECRETS_FILE}" >&2
    exit 1
}

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-supervisor start (dry=${DRY_RUN}) ==="

if [ ! -f "$QUEUE_DB" ]; then
    echo "ERROR: Queue DB not found: $QUEUE_DB" >&2
    exit 1
fi

# ─── ヘルパー ─────────────────────────────────────────────────────────────
SQ() { sqlite3 "$QUEUE_DB" "$1"; }

notify() {
    # priority: 0=normal, 1=high
    local priority="$1"
    local title="$2"
    local body="$3"
    if [ -x "${R2C_ROOT}/SCRIPTS/r2c-pushover.sh" ]; then
        # 通知失敗を完全無音にしない: 失敗時は必ず stderr(=ログ) に痕跡を残す
        bash "${R2C_ROOT}/SCRIPTS/r2c-pushover.sh" --priority "$priority" --title "$title" --message "$body" 2>&1 \
            || echo "WARN: pushover notify failed (priority=${priority}): ${title} — ${body}" >&2
    else
        echo "NOTIFY(priority=${priority}): ${title} — ${body}"
    fi
}

# ─── 1. Stuck Lane 検出 ──────────────────────────────────────────────────
STUCK=$(SQ "SELECT id, asana_gid, asana_name, session_id, COALESCE(attempt_count,0), worktree_path
            FROM tasks
            WHERE state = 'running'
              AND started_at IS NOT NULL
              AND started_at < datetime('now', '-${MAX_RUN_MINUTES} minutes');")

STUCK_COUNT=0
if [ -n "$STUCK" ]; then
    STUCK_COUNT=$(echo "$STUCK" | wc -l | tr -d ' ')
    echo "Detected ${STUCK_COUNT} stuck lane(s) (running > ${MAX_RUN_MINUTES}min)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    if [ -n "$STUCK" ]; then
        echo "DRY-RUN: stuck lanes:"
        echo "$STUCK" | awk -F'|' '{printf "  - task=%s gid=%s attempt=%s name=%s\n", $1, $2, $5, $3}'
    else
        echo "DRY-RUN: no stuck lanes"
    fi
    echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-supervisor done (dry) ==="
    exit 0
fi

if [ -n "$STUCK" ]; then
    while IFS='|' read -r TID GID NAME SID ATTEMPT WORKTREE; do
        [ -z "$TID" ] && continue
        echo "Stuck task ${TID} (gid=${GID:-NA}, attempt=${ATTEMPT}, session=${SID:-NA}): ${NAME}"

        # claude session kill (best-effort)
        if [ -n "$SID" ]; then
            pkill -f "claude.*${SID}" 2>/dev/null || true
        fi

        # worktree cleanup (r2c-lane-cleanup.sh は他 worktree 担当の前提)
        if [ -x "${R2C_ROOT}/SCRIPTS/r2c-lane-cleanup.sh" ]; then
            bash "${R2C_ROOT}/SCRIPTS/r2c-lane-cleanup.sh" --task-id "$TID" 2>&1 || true
        elif [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
            (cd "$R2C_ROOT" && git worktree remove --force "$WORKTREE" 2>&1) || true
        fi

        ATTEMPT_NUM=${ATTEMPT:-0}
        if [ "$ATTEMPT_NUM" -lt "$MAX_ATTEMPTS" ]; then
            SQ "UPDATE tasks SET state='pending', session_id=NULL, worktree_path=NULL, error_message='stuck > ${MAX_RUN_MINUTES}min, auto-retry', last_action='auto_retry' WHERE id = ${TID};"
            echo "  → re-queued for retry (${ATTEMPT_NUM}/${MAX_ATTEMPTS})"
            notify 0 "R2C Lane stuck, retrying" "Task ${TID} stuck >${MAX_RUN_MINUTES}min, retry ${ATTEMPT_NUM}/${MAX_ATTEMPTS}: ${NAME}"
        else
            SQ "UPDATE tasks SET state='rollbacked', error_message='stuck > ${MAX_RUN_MINUTES}min for ${MAX_ATTEMPTS} attempts', last_action='auto_rollback' WHERE id = ${TID};"
            echo "  → rollbacked (${MAX_ATTEMPTS} attempts exhausted)"
            notify 1 "R2C Lane FAILED (rollback)" "Task ${TID} failed ${MAX_ATTEMPTS}x and was rolled back: ${NAME}"
        fi
    done <<< "$STUCK"
fi

# ─── 2. 連続失敗の検出 → dispatching pause ──────────────────────────────
RECENT_FAILED=$(SQ "SELECT COUNT(*) FROM tasks
                    WHERE state IN ('failed','rollbacked')
                      AND COALESCE(updated_at, started_at) > datetime('now', '${RECENT_FAILED_WINDOW}');")
RECENT_FAILED=${RECENT_FAILED:-0}

if [ "$RECENT_FAILED" -ge "$RECENT_FAILED_THRESHOLD" ]; then
    PAUSED_ALREADY=$(SQ "SELECT value FROM automation_state WHERE key = 'pause_dispatching';")
    if [ "${PAUSED_ALREADY:-0}" != "1" ]; then
        echo "CRITICAL: ${RECENT_FAILED} failures in last 2h → pausing dispatching"
        SQ "INSERT OR REPLACE INTO automation_state (key, value) VALUES ('pause_dispatching', '1');"
        notify 1 "R2C Many Failures" "${RECENT_FAILED} tasks failed/rollbacked in last 2h. Dispatching paused."
    fi
fi

# ─── 3. Queue 統計スナップショット ───────────────────────────────────────
echo "Queue stats:"
SQ "SELECT state, COUNT(*) FROM tasks GROUP BY state ORDER BY state;" | sed 's/^/  /'

SQ "INSERT OR REPLACE INTO automation_state (key, value) VALUES ('last_supervisor_run', '$(date -u +%Y-%m-%dT%H:%M:%SZ)');" || true

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-supervisor done ==="
echo ""
