#!/usr/bin/env bash
# r2c-stuck-detector.sh — 24h 自走 stuck 検知 daemon (Phase70-?)
#
# 機能:
#   1. ~/.claude-r2c-config/heartbeat mtime を監視
#   2. ~/.claude/projects/<path>/*.jsonl 最新 mtime を監視
#   3. 30分更新なし → Slack #r2c 警告
#   4. 90分超 → session kill + worktree クリーンアップ + 再dispatch (3回上限)
#   5. 3回失敗 → Slack HIGH + Pushover
#
# 制約: SSH コマンド使用禁止 / DB migration 禁止 / set-e + ${VAR:-0} ガード必須
#
# 使い方:
#   bash SCRIPTS/r2c-stuck-detector.sh [--dry-run] [--one-shot] [--verbose]
#
# 環境変数オーバーライド:
#   STUCK_WARN_THRESHOLD   警告閾値(秒) デフォルト 1800 (30分)
#   STUCK_KILL_THRESHOLD   kill 閾値(秒) デフォルト 5400 (90分)
#   STUCK_POLL_INTERVAL    ポーリング間隔(秒) デフォルト 60
#   MAX_DISPATCH_ATTEMPTS  最大 dispatch 試行回数 デフォルト 3
#   DISPATCH_COMMAND       再dispatch コマンド (未設定時は Slack 通知のみ)
#   HEARTBEAT_FILE         heartbeat ファイルパス (デフォルト: R2C_CONFIG/heartbeat)
#   CLAUDE_PROJECTS_DIR    jsonl 検索ベースディレクトリ (デフォルト: ~/.claude/projects)
#
# Phase: 70-? (Asana GID 1214954523638712)

# shellcheck disable=SC2155
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Config paths ─────────────────────────────────────────────────────────────
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"
NOTIFY="${NOTIFY_SCRIPT:-${SCRIPT_DIR}/notify-slack.sh}"

HEARTBEAT_FILE="${HEARTBEAT_FILE:-${R2C_CONFIG}/heartbeat}"
CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-${HOME}/.claude/projects}"
REPO_DIR="${REPO_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

# ─── Thresholds ───────────────────────────────────────────────────────────────
WARN_THRESHOLD="${STUCK_WARN_THRESHOLD:-1800}"    # 30 min
KILL_THRESHOLD="${STUCK_KILL_THRESHOLD:-5400}"    # 90 min
MAX_DISPATCH="${MAX_DISPATCH_ATTEMPTS:-3}"
POLL_INTERVAL="${STUCK_POLL_INTERVAL:-60}"        # 1 min

# ─── State files ─────────────────────────────────────────────────────────────
DISPATCH_COUNT_FILE="${R2C_CONFIG}/.stuck-dispatch-count"
DISPATCH_LOCK_FILE="${R2C_CONFIG}/.stuck-dispatch-locked"

# ─── CLI options ─────────────────────────────────────────────────────────────
DRY_RUN=0
ONE_SHOT=0
VERBOSE=0

usage() {
    cat <<'USAGE'
Usage: r2c-stuck-detector.sh [options]

Options:
  --dry-run    検知のみ実行(kill/dispatch は行わない)
  --one-shot   1 サイクルだけ実行して終了(テスト用)
  --verbose    詳細ログ出力
  -h, --help   このヘルプを表示

環境変数:
  STUCK_WARN_THRESHOLD  警告閾値(秒) デフォルト 1800
  STUCK_KILL_THRESHOLD  kill 閾値(秒) デフォルト 5400
  STUCK_POLL_INTERVAL   ポーリング間隔(秒) デフォルト 60
  MAX_DISPATCH_ATTEMPTS 最大 dispatch 試行回数 デフォルト 3
  DISPATCH_COMMAND      再dispatch コマンド
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)  DRY_RUN=1; shift ;;
        --one-shot) ONE_SHOT=1; shift ;;
        --verbose)  VERBOSE=1; shift ;;
        -h|--help)  usage; exit 0 ;;
        *) printf 'ERROR: unknown option: %s\n' "$1" >&2; usage; exit 1 ;;
    esac
done

# ─── Logging ─────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/${SCRIPT_NAME}.log"
# Redirect stdout/stderr to log only when not in one-shot/test mode
if [[ "${ONE_SHOT:-0}" -eq 0 && "${STUCK_DETECTOR_SOURCED:-0}" -eq 0 ]]; then
    exec >> "$LOG_FILE" 2>&1
fi

ts()   { date '+%Y-%m-%d %H:%M:%S'; }
log()  { printf '[%s] [%s] %s\n' "$(ts)" "$SCRIPT_NAME" "$*"; }
vlog() { [[ "${VERBOSE:-0}" -eq 1 ]] && log "$*" || true; }

# ─── File mtime (macOS stat -f / Linux stat -c) ───────────────────────────────
get_file_mtime() {
    local file="${1:-}"
    [[ -f "${file}" ]] || { echo "0"; return 0; }
    local mtime
    mtime=$(stat -f %m "${file}" 2>/dev/null \
        || stat -c %Y "${file}" 2>/dev/null \
        || echo "0")
    echo "${mtime:-0}"
}

# ─── Heartbeat mtime ─────────────────────────────────────────────────────────
get_heartbeat_mtime() {
    get_file_mtime "${HEARTBEAT_FILE}"
}

# ─── Newest JSONL mtime under ~/.claude/projects/ ────────────────────────────
get_newest_jsonl_mtime() {
    local projects_dir="${1:-$CLAUDE_PROJECTS_DIR}"
    [[ -d "${projects_dir}" ]] || { echo "0"; return 0; }
    local newest=0
    local mtime
    while IFS= read -r -d '' f; do
        mtime=$(get_file_mtime "${f}")
        mtime="${mtime:-0}"
        if [[ "${mtime:-0}" -gt "${newest:-0}" ]]; then
            newest="${mtime}"
        fi
    done < <(find "${projects_dir}" -name "*.jsonl" -maxdepth 4 -print0 2>/dev/null || true)
    echo "${newest:-0}"
}

# ─── sqlite3 count guard (UATa 事例 #2: 空文字列 → 整数比較 SIGFPE 防止) ────────
# 呼び出し: get_sqlite_count <db_path> <query>
# 返値: 整数(0以上)。DB不在・空文字・非整数は 0 を返す。
get_sqlite_count() {
    local db="${1:-}" query="${2:-SELECT 1}"
    [[ -f "${db}" ]] || { echo "0"; return 0; }
    local count
    count=$(sqlite3 "${db}" "${query}" 2>/dev/null || echo "0")
    count="${count:-0}"
    # Guard: 非整数は 0 に正規化
    if ! [[ "${count}" =~ ^[0-9]+$ ]]; then
        count=0
    fi
    echo "${count:-0}"
}

# ─── Latest activity: max(heartbeat mtime, newest jsonl mtime) ───────────────
get_latest_activity() {
    local hb_mtime jsonl_mtime
    hb_mtime=$(get_heartbeat_mtime)
    hb_mtime="${hb_mtime:-0}"
    jsonl_mtime=$(get_newest_jsonl_mtime)
    jsonl_mtime="${jsonl_mtime:-0}"
    if [[ "${hb_mtime:-0}" -gt "${jsonl_mtime:-0}" ]]; then
        echo "${hb_mtime:-0}"
    else
        echo "${jsonl_mtime:-0}"
    fi
}

# ─── Stale seconds (0 を返す場合はハートビートなし ─ false-alarm 防止) ────────
get_stale_secs() {
    local latest now stale
    latest=$(get_latest_activity)
    latest="${latest:-0}"
    if [[ "${latest:-0}" -eq 0 ]]; then
        # heartbeat ファイルが一切存在しない = 24h 自走未開始とみなし false-alarm 防止
        echo "0"
        return 0
    fi
    now=$(date +%s)
    now="${now:-0}"
    stale=$(( ${now:-0} - ${latest:-0} ))
    echo "${stale:-0}"
}

# ─── Dispatch attempt tracking ───────────────────────────────────────────────
get_dispatch_count() {
    [[ -f "${DISPATCH_COUNT_FILE}" ]] || { echo "0"; return 0; }
    local count
    count=$(cat "${DISPATCH_COUNT_FILE}" 2>/dev/null || echo "0")
    count="${count:-0}"
    if ! [[ "${count}" =~ ^[0-9]+$ ]]; then
        count=0
    fi
    echo "${count:-0}"
}

increment_dispatch_count() {
    local current
    current=$(get_dispatch_count)
    current="${current:-0}"
    printf '%d\n' "$(( ${current:-0} + 1 ))" > "${DISPATCH_COUNT_FILE}"
}

reset_dispatch_count() {
    printf '0\n' > "${DISPATCH_COUNT_FILE}"
    [[ -f "${DISPATCH_LOCK_FILE}" ]] && rm -f "${DISPATCH_LOCK_FILE}" || true
}

# ─── Session kill (SIGTERM → 3秒待機 → SIGKILL) ───────────────────────────────
kill_session() {
    log "Killing stuck Claude session..."
    if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
        log "[dry-run] would: pkill -TERM -f 'node.*claude'"
        return 0
    fi
    pkill -TERM -f "node.*claude" 2>/dev/null || true
    sleep 3
    pkill -KILL -f "node.*claude" 2>/dev/null || true
    log "Session kill sent."
}

# ─── Worktree cleanup ─────────────────────────────────────────────────────────
cleanup_worktrees() {
    log "Cleaning up worktrees in ${REPO_DIR}..."
    if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
        log "[dry-run] would: git worktree remove --force <non-main worktrees>"
        return 0
    fi
    [[ -d "${REPO_DIR}/.git" ]] || {
        log "WARN: ${REPO_DIR} is not a git repo root, skipping worktree cleanup"
        return 0
    }
    local main_path wt_path
    main_path="$(cd "${REPO_DIR}" && git rev-parse --show-toplevel 2>/dev/null || echo "${REPO_DIR}")"
    main_path="${main_path:-${REPO_DIR}}"
    (
        cd "${REPO_DIR}" || exit 0
        git worktree list --porcelain 2>/dev/null \
            | grep "^worktree" \
            | awk '{print $2}' \
            | while IFS= read -r wt_path; do
                if [[ "${wt_path}" != "${main_path}" ]]; then
                    log "Removing worktree: ${wt_path}"
                    git worktree remove --force "${wt_path}" 2>/dev/null || true
                fi
            done
        git worktree prune 2>/dev/null || true
    )
    log "Worktree cleanup done."
}

# ─── Re-dispatch (attempts をインクリメントしてから実行) ─────────────────────
dispatch_session() {
    local current_count new_count
    current_count=$(get_dispatch_count)
    current_count="${current_count:-0}"

    if [[ "${current_count:-0}" -ge "${MAX_DISPATCH:-3}" ]]; then
        log "ERROR: max dispatch attempts (${MAX_DISPATCH:-3}) reached."
        return 1
    fi

    increment_dispatch_count
    new_count=$(get_dispatch_count)
    new_count="${new_count:-0}"
    log "Dispatching new session (attempt ${new_count:-0}/${MAX_DISPATCH:-3})..."

    if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
        log "[dry-run] would dispatch: DISPATCH_COMMAND=${DISPATCH_COMMAND:-<unset>}"
        return 0
    fi

    # heartbeat リセット (再 dispatch を記録)
    mkdir -p "$(dirname "${HEARTBEAT_FILE}")"
    touch "${HEARTBEAT_FILE}" 2>/dev/null || true

    local dispatch_cmd="${DISPATCH_COMMAND:-}"
    if [[ -n "${dispatch_cmd}" ]]; then
        log "Executing: ${dispatch_cmd}"
        eval "${dispatch_cmd}" &
        disown 2>/dev/null || true
    else
        log "WARN: DISPATCH_COMMAND not configured. Manual restart required."
        "$NOTIFY" \
            "⚠️ stuck-detector: session kill 完了 (attempt ${new_count:-0}/${MAX_DISPATCH:-3})。DISPATCH_COMMAND 未設定のため手動再起動してください。" \
            --color warning 2>/dev/null || true
    fi
    return 0
}

# ─── Pushover (credentials 未設定時は silent skip) ───────────────────────────
notify_pushover() {
    local message="${1:-}"
    # shellcheck disable=SC1091
    [[ -f "${R2C_CONFIG}/secrets/r2c-loop.env" ]] \
        && source "${R2C_CONFIG}/secrets/r2c-loop.env" || true
    local token="${PUSHOVER_APP_TOKEN:-}"
    local user="${PUSHOVER_USER_KEY:-}"
    if [[ -z "${token}" || -z "${user}" ]]; then
        log "WARN: Pushover credentials not set (PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY)"
        return 0
    fi
    if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
        log "[dry-run] Pushover: ${message}"
        return 0
    fi
    curl -sS --max-time 10 \
        -F "token=${token}" \
        -F "user=${user}" \
        -F "message=${message}" \
        -F "priority=1" \
        "https://api.pushover.net/1/messages.json" > /dev/null 2>&1 \
        || log "WARN: Pushover notification failed"
}

# ─── Action: 30分警告 ─────────────────────────────────────────────────────────
action_warn() {
    local stale_secs="${1:-0}"
    local stale_mins=$(( ${stale_secs:-0} / 60 ))
    log "WARN: 30分以上更新なし (${stale_mins:-0}分経過)"
    if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
        log "[dry-run] would: notify-slack warning"
        return 0
    fi
    "$NOTIFY" \
        "⚠️ R2C stuck-detector: ${stale_mins:-0}分間 heartbeat 更新なし。セッションが止まっている可能性があります。" \
        --color warning 2>/dev/null || true
}

# ─── Action: 90分 kill + dispatch ─────────────────────────────────────────────
action_kill_and_dispatch() {
    local stale_secs="${1:-0}"
    local stale_mins=$(( ${stale_secs:-0} / 60 ))
    local attempt
    attempt=$(get_dispatch_count)
    attempt="${attempt:-0}"
    local next_attempt=$(( ${attempt:-0} + 1 ))

    log "ERROR: ${stale_mins:-0}分無応答 — kill + dispatch 開始 (attempt ${next_attempt:-1}/${MAX_DISPATCH:-3})"

    if [[ "${DRY_RUN:-0}" -eq 1 ]]; then
        log "[dry-run] would: Slack error, kill_session, cleanup_worktrees, dispatch_session"
        return 0
    fi

    "$NOTIFY" \
        "🔴 R2C stuck-detector: ${stale_mins:-0}分無応答。session kill + worktree cleanup → 再dispatch (attempt ${next_attempt:-1}/${MAX_DISPATCH:-3})" \
        --color error 2>/dev/null || true

    kill_session
    cleanup_worktrees

    if ! dispatch_session; then
        # 3回上限到達 → HIGH + Pushover
        log "ERROR: max dispatch attempts reached — HUMAN-REVIEW-REQUIRED"
        "$NOTIFY" \
            "🚨 R2C stuck-detector: 再dispatch ${MAX_DISPATCH:-3}回失敗。HUMAN-REVIEW-REQUIRED。手動確認してください。" \
            --color error 2>/dev/null || true
        notify_pushover "R2C stuck-detector: ${MAX_DISPATCH:-3}回 re-dispatch 失敗。HUMAN-REVIEW-REQUIRED。"
        touch "${DISPATCH_LOCK_FILE}"
    fi
}

# ─── 1サイクル ────────────────────────────────────────────────────────────────
run_check() {
    local stale_secs
    stale_secs=$(get_stale_secs)
    stale_secs="${stale_secs:-0}"

    vlog "stale=${stale_secs:-0}s warn=${WARN_THRESHOLD:-1800}s kill=${KILL_THRESHOLD:-5400}s"

    # dispatch がロックされていれば何もしない
    if [[ -f "${DISPATCH_LOCK_FILE}" ]]; then
        vlog "dispatch locked (max attempts reached), skipping"
        return 0
    fi

    if [[ "${stale_secs:-0}" -ge "${KILL_THRESHOLD:-5400}" ]]; then
        action_kill_and_dispatch "${stale_secs}"
    elif [[ "${stale_secs:-0}" -ge "${WARN_THRESHOLD:-1800}" ]]; then
        action_warn "${stale_secs}"
    else
        vlog "healthy (stale=${stale_secs:-0}s)"
        # 正常稼働中は dispatch カウントをリセット
        if [[ -f "${DISPATCH_COUNT_FILE}" ]]; then
            reset_dispatch_count
        fi
    fi
}

# ─── メインループ ─────────────────────────────────────────────────────────────
main() {
    log "r2c-stuck-detector start (warn=${WARN_THRESHOLD:-1800}s kill=${KILL_THRESHOLD:-5400}s poll=${POLL_INTERVAL:-60}s dry_run=${DRY_RUN:-0} one_shot=${ONE_SHOT:-0})"

    # secrets ロード
    # shellcheck disable=SC1091
    [[ -f "${R2C_CONFIG}/secrets/r2c-loop.env" ]] \
        && source "${R2C_CONFIG}/secrets/r2c-loop.env" || true

    mkdir -p "${R2C_CONFIG}"

    if [[ "${ONE_SHOT:-0}" -eq 1 ]]; then
        run_check
        return 0
    fi

    while true; do
        run_check
        sleep "${POLL_INTERVAL:-60}"
    done
}

# テスト用 source 時はメイン実行しない
[[ "${STUCK_DETECTOR_SOURCED:-0}" -eq 1 ]] || main
