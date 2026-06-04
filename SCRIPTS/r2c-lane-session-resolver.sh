#!/usr/bin/env bash
# r2c-lane-session-resolver.sh
# 用途: dispatch.sh が claude --bg で Lane を spawn した直後に呼ばれ、
#       claude agents --json から lane_name で sessionId を引き、
#       r2c-queue-update.sh 経由で tasks.session_id を書き戻す。
#
# 背景: PR #197 残存リスク② — session_id は Lane 側 r2c-queue-update.sh
#       --session-id 呼出に依存していたため、Lane が即死した場合 session_id
#       が NULL のまま supervisor の pkill が no-op になる構造欠陥があった。
#       2026-05-26 OAuth daemon 凍結事故で 33 件全 rollback の主因となり、
#       本スクリプトで dispatch 側自動発見に切替える。
#
# 引数:
#   --task-id <id>     必須
#   --lane-name <name> 必須 (claude --bg --name と一致)
#   --log-file <path>  必須 (sid 解決ログの出力先、.sid サフィックス推奨)
#
# 終了コード: 常に 0 (Lane の自走を妨げないため、失敗時も warning ログのみ)

set -uo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"

TASK_ID=""
LANE_NAME=""
LOG_FILE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --task-id)   TASK_ID="${2:-}"; shift 2 ;;
        --lane-name) LANE_NAME="${2:-}"; shift 2 ;;
        --log-file)  LOG_FILE="${2:-}"; shift 2 ;;
        *) echo "ERROR: unknown arg: $1" >&2; exit 0 ;;
    esac
done

if [ -z "$TASK_ID" ] || [ -z "$LANE_NAME" ] || [ -z "$LOG_FILE" ]; then
    echo "ERROR: --task-id, --lane-name, --log-file are required" >&2
    exit 0
fi

ts() { date +'%Y-%m-%dT%H:%M:%S'; }

# claude agents --json が反映されるまで最大 5 回 x 2秒 = 10秒 待機
SID=""
for _ in 1 2 3 4 5; do
    sleep 2
    SID=$(claude agents --json 2>/dev/null \
        | jq -r --arg n "$LANE_NAME" '.[] | select(.name==$n) | .sessionId' 2>/dev/null \
        | head -1)
    if [ -n "$SID" ]; then
        break
    fi
done

if [ -n "$SID" ]; then
    bash "${R2C_ROOT}/SCRIPTS/r2c-queue-update.sh" \
        --task-id "$TASK_ID" \
        --session-id "$SID" >> "$LOG_FILE" 2>&1 || true
    echo "[$(ts)] session_id resolved: task=${TASK_ID} sid=${SID}" >> "$LOG_FILE"
else
    echo "[$(ts)] WARNING: session_id auto-discovery failed for task=${TASK_ID} lane=${LANE_NAME} (Lane will run, but supervisor pkill may no-op)" >> "$LOG_FILE"
fi

exit 0
