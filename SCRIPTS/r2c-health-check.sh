#!/usr/bin/env bash
# r2c-health-check.sh — Production /health endpoint check (R2C 24h loop)
#
# 用途:
#   - https://api.r2c.biz/health に curl して status code を取得
#   - 直近 5 分連続 503 を検出 → Pushover priority 2 で通知 (--with-pushover 時)
#   - SQLite に履歴を残し morning-report の L1 集計に使う
#
# 環境変数:
#   R2C_ROOT, R2C_CONFIG, QUEUE_DB, LOG_DIR (デフォルト bake-in)
#
# 呼び出し例:
#   bash SCRIPTS/r2c-health-check.sh                # 通常実行
#   bash SCRIPTS/r2c-health-check.sh --with-pushover  # 5 分連続 503 で Pushover
#   bash SCRIPTS/r2c-health-check.sh --json         # JSON stdout
#   bash SCRIPTS/r2c-health-check.sh --dry-run      # 履歴書き込みなし

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/Documents/GitHub/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"
LOG_DIR="${LOG_DIR:-${R2C_CONFIG}/logs}"
API_HEALTH_URL="${API_HEALTH_URL:-https://api.r2c.biz/health}"

WITH_PUSHOVER=0
DRY_RUN=0
JSON_OUTPUT=0

# Args
while [ $# -gt 0 ]; do
    case "$1" in
        --with-pushover) WITH_PUSHOVER=1; shift ;;
        --dry-run)       DRY_RUN=1; shift ;;
        --json)          JSON_OUTPUT=1; shift ;;
        *)               echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/health-check.log"

# log mode (json / dry-run は stdout を保持)
if [ "${JSON_OUTPUT}" -eq 0 ] && [ "${DRY_RUN}" -eq 0 ]; then
    exec >> "${LOG_FILE}" 2>&1
fi

# shellcheck disable=SC1091
source "${R2C_CONFIG}/secrets/r2c-loop.env" 2>/dev/null || true

# Schema: health_check_history (idempotent CREATE)
if [ "${DRY_RUN}" -eq 0 ] && [ -f "${QUEUE_DB}" ]; then
    sqlite3 "${QUEUE_DB}" <<'SQL'
CREATE TABLE IF NOT EXISTS health_check_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status_code INTEGER NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_health_checked_at ON health_check_history(checked_at);
DELETE FROM health_check_history WHERE checked_at < datetime('now', '-1 day');
SQL
fi

CHECKED_AT=$(date +%Y-%m-%dT%H:%M:%S%z)

# curl with 10s timeout
HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 "${API_HEALTH_URL}" 2>/dev/null || echo "000")

if [ "${DRY_RUN}" -eq 1 ]; then
    echo "[dry-run] would log: status_code=${HTTP_CODE} at ${CHECKED_AT}"
elif [ -f "${QUEUE_DB}" ]; then
    sqlite3 "${QUEUE_DB}" "INSERT INTO health_check_history(status_code) VALUES(${HTTP_CODE});"
fi

# JSON output
if [ "${JSON_OUTPUT}" -eq 1 ]; then
    STATUS_TEXT="ok"
    [ "${HTTP_CODE}" != "200" ] && STATUS_TEXT="down"
    printf '{"status":"%s","http_code":%s,"checked_at":"%s","url":"%s"}\n' \
        "${STATUS_TEXT}" "${HTTP_CODE}" "${CHECKED_AT}" "${API_HEALTH_URL}"
fi

# Pushover priority 2: 5 分連続 503 (or 5xx) 判定
if [ "${WITH_PUSHOVER}" -eq 1 ] && [ "${DRY_RUN}" -eq 0 ] && [ -f "${QUEUE_DB}" ]; then
    FAIL_COUNT=$(sqlite3 "${QUEUE_DB}" "SELECT COUNT(*) FROM health_check_history WHERE checked_at >= datetime('now', '-5 minutes') AND status_code != 200;")
    if [ "${FAIL_COUNT}" -ge 5 ]; then
        bash "${R2C_ROOT}/SCRIPTS/r2c-pushover.sh" \
            --priority 2 \
            --summary "/health DOWN 5min連続" \
            --details-url "${API_HEALTH_URL}" || true
    fi
fi

if [ "${HTTP_CODE}" = "200" ]; then
    exit 0
else
    exit 1
fi
