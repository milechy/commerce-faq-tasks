#!/usr/bin/env bash
# r2c-cron-wrapper.sh — launchd / cron 共通 wrapper (R2C 24h loop)
#
# 用途:
#   - launchd / cron の最小 PATH 環境で R2C scripts を確実に起動
#   - PATH 設定 + env load + log rotation + 失敗時 Pushover を共通化
#
# 環境変数:
#   R2C_ROOT, R2C_CONFIG, LOG_DIR
#
# 呼び出し例:
#   bash SCRIPTS/r2c-cron-wrapper.sh --script r2c-asana-poll.sh
#   bash SCRIPTS/r2c-cron-wrapper.sh --script r2c-dispatch.sh -- --auto
#   bash SCRIPTS/r2c-cron-wrapper.sh --script r2c-health-check.sh -- --with-pushover
#   bash SCRIPTS/r2c-cron-wrapper.sh --script r2c-asana-poll.sh --dry-run

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${LOG_DIR:-${R2C_CONFIG}/logs}"

# launchd は最小 PATH なので明示設定 (Homebrew / Python / Node)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/opt/postgresql@17/bin:${PATH:-}"

SCRIPT=""
DRY_RUN=0
PASS_THROUGH=()

# 引数パース: --script <name> [--dry-run] [-- <pass-through args>]
while [ $# -gt 0 ]; do
    case "$1" in
        --script)  SCRIPT="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --)        shift; PASS_THROUGH=("$@"); break ;;
        *)         PASS_THROUGH+=("$1"); shift ;;
    esac
done

if [ -z "${SCRIPT}" ]; then
    echo "ERROR: --script <name> required" >&2
    echo "Usage: $0 --script r2c-foo.sh [-- pass-through-args...]" >&2
    exit 1
fi

# script 名 validation (path traversal 防御): スラッシュ含む / .. 始まりを拒否
case "${SCRIPT}" in
    */*|..*)
        echo "ERROR: --script must be plain filename (no path / no '..')" >&2
        exit 1
        ;;
esac

mkdir -p "${LOG_DIR}"
WRAPPER_LOG="${LOG_DIR}/cron-wrapper.log"
TARGET_LOG="${LOG_DIR}/${SCRIPT%.sh}.log"

# log rotation: 10MB 超で .1 にローテート
rotate_log() {
    local f="$1"
    [ -f "${f}" ] || return 0
    local size
    if [ "$(uname)" = "Darwin" ]; then
        size=$(stat -f %z "${f}" 2>/dev/null || echo 0)
    else
        size=$(stat -c %s "${f}" 2>/dev/null || echo 0)
    fi
    if [ "${size}" -gt 10485760 ]; then
        mv "${f}" "${f}.1"
        : > "${f}"
    fi
}

rotate_log "${WRAPPER_LOG}"
rotate_log "${TARGET_LOG}"

# env load (失敗しても続行)
# shellcheck disable=SC1091
source "${R2C_CONFIG}/secrets/r2c-loop.env" 2>/dev/null || true

if [ "${DRY_RUN}" -eq 1 ]; then
    echo "=== r2c-cron-wrapper dry-run ==="
    echo "PATH=${PATH}"
    echo "R2C_ROOT=${R2C_ROOT}"
    echo "R2C_CONFIG=${R2C_CONFIG}"
    echo "SCRIPT=${SCRIPT}"
    echo "PASS_THROUGH=${PASS_THROUGH[*]:-}"
    echo "TARGET_LOG=${TARGET_LOG}"
    if [ -x "${R2C_ROOT}/SCRIPTS/${SCRIPT}" ]; then
        echo "TARGET_EXISTS=yes"
    else
        echo "TARGET_EXISTS=NO (or not executable)"
    fi
    exit 0
fi

# wrapper log にエントリを残す
{
    echo "[$(date +%Y-%m-%d_%H:%M:%S)] start ${SCRIPT} args=${PASS_THROUGH[*]:-}"
} >> "${WRAPPER_LOG}"

cd "${R2C_ROOT}"

START_TS=$(date +%s)
set +e
# bash 3.2 (macOS) では空配列の "${arr[@]:-}" が空文字列1個に展開され、
# 引数なし起動のはずの script に "" が渡って "unknown arg" で落ちる。
# pass-through の有無で分岐し、空配列時は引数を一切渡さない。
if [ "${#PASS_THROUGH[@]}" -gt 0 ]; then
    bash "SCRIPTS/${SCRIPT}" "${PASS_THROUGH[@]}" >> "${TARGET_LOG}" 2>&1
else
    bash "SCRIPTS/${SCRIPT}" >> "${TARGET_LOG}" 2>&1
fi
EXIT_CODE=$?
set -e
END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

{
    echo "[$(date +%Y-%m-%d_%H:%M:%S)] end ${SCRIPT} exit=${EXIT_CODE} duration=${DURATION}s"
} >> "${WRAPPER_LOG}"

# 失敗時 Pushover
if [ "${EXIT_CODE}" -ne 0 ]; then
    PUSHOVER="${R2C_ROOT}/SCRIPTS/r2c-pushover.sh"
    if [ -x "${PUSHOVER}" ]; then
        "${PUSHOVER}" \
            --priority 0 \
            --summary "${SCRIPT} failed exit=${EXIT_CODE}" \
            --details-url "file://${TARGET_LOG}" 2>>"${WRAPPER_LOG}" || true
    fi
fi

exit "${EXIT_CODE}"
