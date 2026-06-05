#!/usr/bin/env bash
# r2c-lane-spawn-checker.sh
# 用途: Lane の Claude --bg プロセスが SPAWN_WINDOW 秒以内に正常起動したか確認する。
#       起動失敗を検出したら DB を失敗状態に遷移し、プロセスを kill する。
#       dispatch_one から nohup バックグラウンドで起動される。
#
# 欠陥3点修正 (PR #252/253 教訓 — docs/AGENT_TEAMS_BASH_PERMISSION_BUG.md §5.1 参照):
#   ①kill シグナル欠落  → TERM + 5秒後 KILL で確実にプロセス終了
#   ②窓幅短すぎ(60秒)  → SPAWN_WINDOW=180 に延長 (実測: 正常起動は120秒以内)
#   ③session_id 残存   → UPDATE ... session_id=NULL で二重 dispatch を防止
#
# 呼び出し:
#   nohup bash r2c-lane-spawn-checker.sh \
#       --task-id N --lane-name L --log-file F --nohup-pid P \
#       > /dev/null 2>&1 &
#
# 依存:
#   SCRIPTS/r2c-pushover.sh (失敗通知), sqlite3, kill

set -uo pipefail

# ─── 定数 ────────────────────────────────────────────────────────────────────
SPAWN_WINDOW=180          # 正常起動を待つ最大秒数 (UATa 実測: 120秒以内に活動開始)
KILL_GRACE=5              # SIGTERM 後に SIGKILL を送るまでの猶予秒数
# idle バナー: Claude Code が起動直後に出力するプロンプト待ち表示
IDLE_BANNER="(idle — send a prompt to start)"

# ─── 引数 ────────────────────────────────────────────────────────────────────
TASK_ID=""
LANE_NAME=""
LOG_FILE=""
NOHUP_PID=""

while [ $# -gt 0 ]; do
    case "$1" in
        --task-id)   TASK_ID="$2";   shift 2 ;;
        --lane-name) LANE_NAME="$2"; shift 2 ;;
        --log-file)  LOG_FILE="$2";  shift 2 ;;
        --nohup-pid) NOHUP_PID="$2"; shift 2 ;;
        *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
    esac
done

for required in TASK_ID LANE_NAME LOG_FILE NOHUP_PID; do
    if [ -z "${!required}" ]; then
        echo "ERROR: --${required,,} is required" >&2
        exit 1
    fi
done

# ─── 環境設定 ────────────────────────────────────────────────────────────────
R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
QUEUE_DB="${R2C_ROOT}/.claude/queue/r2c-queue.db"

SQ() { sqlite3 "${QUEUE_DB}" "$1"; }

# ─── 起動待機 ────────────────────────────────────────────────────────────────
sleep "${SPAWN_WINDOW}"

# ─── 失敗判定 ────────────────────────────────────────────────────────────────
# 失敗条件: ログが存在しない / 0 バイト / idle バナーのみ (プロンプト未受信)
is_failed() {
    # ログが存在しない
    if [ ! -f "${LOG_FILE}" ]; then
        echo "SPAWN_CHECKER: log not found: ${LOG_FILE}"
        return 0
    fi

    local size
    size=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)

    # 0 バイト
    if [ "${size}" -eq 0 ]; then
        echo "SPAWN_CHECKER: log is 0 bytes"
        return 0
    fi

    # idle バナーのみ (実際の prompt 処理が始まっていない)
    if grep -qF "${IDLE_BANNER}" "${LOG_FILE}" && \
       ! grep -qvF "${IDLE_BANNER}" "${LOG_FILE}"; then
        echo "SPAWN_CHECKER: log contains only idle banner"
        return 0
    fi

    return 1
}

if ! is_failed; then
    echo "SPAWN_CHECKER: task=${TASK_ID} lane=${LANE_NAME} — OK (log has activity)"
    exit 0
fi

# ─── 失敗処理 ────────────────────────────────────────────────────────────────
echo "SPAWN_CHECKER: task=${TASK_ID} lane=${LANE_NAME} FAILED — marking failed and killing pid=${NOHUP_PID}"

# ① プロセス kill: SIGTERM → 猶予 → SIGKILL
if kill -0 "${NOHUP_PID}" 2>/dev/null; then
    kill -TERM "${NOHUP_PID}" 2>/dev/null || true
    sleep "${KILL_GRACE}"
    if kill -0 "${NOHUP_PID}" 2>/dev/null; then
        kill -KILL "${NOHUP_PID}" 2>/dev/null || true
    fi
fi

# ③ DB 更新: session_id=NULL で二重 dispatch を防止 (欠陥③修正)
SQ "UPDATE tasks SET
    state='failed',
    session_id=NULL,
    error_message='spawn_checker: no activity within ${SPAWN_WINDOW}s',
    last_action='spawn_check_failed',
    updated_at=datetime('now')
WHERE id=${TASK_ID} AND state='running';" 2>/dev/null || \
    echo "SPAWN_CHECKER: WARNING: DB update failed (task may already be in different state)"

# Pushover 通知
if [ -f "${R2C_ROOT}/SCRIPTS/r2c-pushover.sh" ]; then
    bash "${R2C_ROOT}/SCRIPTS/r2c-pushover.sh" \
        --priority 0 \
        --summary "Lane spawn 失敗: ${LANE_NAME} (task=${TASK_ID})" \
        --details-url "$(SQ "SELECT asana_permalink FROM tasks WHERE id=${TASK_ID};" 2>/dev/null || true)" \
        > /dev/null 2>&1 || true
fi

echo "SPAWN_CHECKER: task=${TASK_ID} — marked failed, session_id cleared, process killed"
exit 0
