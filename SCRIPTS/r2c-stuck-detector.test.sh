#!/usr/bin/env bash
# r2c-stuck-detector.test.sh
# テスト対象: SCRIPTS/r2c-stuck-detector.sh
#
# カバー範囲:
#   1. get_heartbeat_mtime — heartbeat ファイル不在 → 0
#   2. get_newest_jsonl_mtime — 空ディレクトリ → 0
#   3. get_sqlite_count — sqlite3 空文字返却 / DB不在 → 0
#   4. get_stale_secs — heartbeat 不在 → false-alarm 防止で 0
#   5. get_stale_secs — 新鮮なファイル → 0〜WARN 未満
#   6. stuck 判定 — 30分閾値テスト (STUCK_WARN_THRESHOLD=5)
#   7. stuck 判定 — 90分閾値テスト (STUCK_KILL_THRESHOLD=10)
#   8. get_sqlite_count — 非整数文字列 → 0 (ガード確認)
#   9. get_dispatch_count — ファイル不在 → 0
#  10. increment/reset dispatch count
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DETECTOR="${SCRIPT_DIR}/r2c-stuck-detector.sh"

# ─── テストフレームワーク ─────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "${expected}" == "${actual}" ]]; then
        printf '  PASS: %s\n' "${desc}"
        (( PASS++ )) || true
    else
        printf '  FAIL: %s\n    expected=%q  actual=%q\n' "${desc}" "${expected}" "${actual}"
        (( FAIL++ )) || true
    fi
}

assert_ge() {
    local desc="$1" min="$2" actual="$3"
    if [[ "${actual:-0}" -ge "${min:-0}" ]]; then
        printf '  PASS: %s\n' "${desc}"
        (( PASS++ )) || true
    else
        printf '  FAIL: %s (expected>=%s, actual=%s)\n' "${desc}" "${min}" "${actual}"
        (( FAIL++ )) || true
    fi
}

assert_lt() {
    local desc="$1" max="$2" actual="$3"
    if [[ "${actual:-0}" -lt "${max:-0}" ]]; then
        printf '  PASS: %s\n' "${desc}"
        (( PASS++ )) || true
    else
        printf '  FAIL: %s (expected<%s, actual=%s)\n' "${desc}" "${max}" "${actual}"
        (( FAIL++ )) || true
    fi
}

# ─── 一時環境 ─────────────────────────────────────────────────────────────────
TMPDIR_TEST="$(mktemp -d /tmp/stuck-detector-test-XXXXXX)"
cleanup() { rm -rf "${TMPDIR_TEST}"; }
trap cleanup EXIT

# スクリプトを source してテスト用関数を展開
export STUCK_DETECTOR_SOURCED=1
export R2C_CONFIG="${TMPDIR_TEST}/r2c-config"
export HEARTBEAT_FILE="${TMPDIR_TEST}/heartbeat"
export CLAUDE_PROJECTS_DIR="${TMPDIR_TEST}/projects"
export REPO_DIR="${TMPDIR_TEST}/repo"
export LOG_DIR="${TMPDIR_TEST}/logs"
export DRY_RUN=1
export ONE_SHOT=1

mkdir -p "${R2C_CONFIG}/logs" "${CLAUDE_PROJECTS_DIR}" "${REPO_DIR}"

# shellcheck disable=SC1090
source "${DETECTOR}"

# ─── テスト 1: heartbeat 不在 → 0 ────────────────────────────────────────────
printf '\n[T1] get_heartbeat_mtime — heartbeat ファイル不在\n'
rm -f "${HEARTBEAT_FILE}"
result=$(get_heartbeat_mtime)
assert_eq "heartbeat不在 → 0" "0" "${result}"

# ─── テスト 2: get_newest_jsonl_mtime — 空ディレクトリ → 0 ───────────────────
printf '\n[T2] get_newest_jsonl_mtime — jsonl ファイルなし\n'
result=$(get_newest_jsonl_mtime "${TMPDIR_TEST}/empty_dir_$$")
assert_eq "jsonlなし → 0" "0" "${result}"

# ─── テスト 3: get_sqlite_count — DB 不在 → 0 ────────────────────────────────
printf '\n[T3] get_sqlite_count — DB ファイル不在\n'
result=$(get_sqlite_count "${TMPDIR_TEST}/nonexistent.db" "SELECT COUNT(*) FROM foo")
assert_eq "DB不在 → 0" "0" "${result}"

# ─── テスト 4: get_sqlite_count — sqlite3 空文字返却 → 0 (UATa 事例 #2) ──────
printf '\n[T4] get_sqlite_count — 空文字フォールバック (空テーブル)\n'
SQLITE_DB="${TMPDIR_TEST}/test.db"
sqlite3 "${SQLITE_DB}" "CREATE TABLE t (v INTEGER);" 2>/dev/null || true
result=$(get_sqlite_count "${SQLITE_DB}" "SELECT COUNT(*) FROM t")
assert_eq "空テーブル → 0" "0" "${result}"

# ─── テスト 5: get_sqlite_count — 非整数文字列 → 0 ───────────────────────────
printf '\n[T5] get_sqlite_count — 非整数返却 → ガード確認\n'
sqlite3 "${SQLITE_DB}" "CREATE TABLE s (v TEXT); INSERT INTO s VALUES ('abc');" 2>/dev/null || true
result=$(get_sqlite_count "${SQLITE_DB}" "SELECT v FROM s LIMIT 1")
assert_eq "非整数 → 0 (ガード)" "0" "${result}"

# ─── テスト 6: get_stale_secs — heartbeat 不在 → 0 (false-alarm 防止) ─────────
printf '\n[T6] get_stale_secs — heartbeat 不在 → false-alarm 防止で 0\n'
rm -f "${HEARTBEAT_FILE}"
result=$(get_stale_secs)
assert_eq "heartbeat不在 → stale=0" "0" "${result}"

# ─── テスト 7: get_stale_secs — 新鮮な heartbeat → stale 小さい ─────────────
printf '\n[T7] get_stale_secs — 直前に touch した heartbeat → stale < 5\n'
touch "${HEARTBEAT_FILE}"
result=$(get_stale_secs)
assert_lt "新鮮なheartbeat → stale<5" "5" "${result}"

# ─── テスト 8: 30分閾値 (STUCK_WARN_THRESHOLD=5) ────────────────────────────
printf '\n[T8] stuck 判定 — 30分閾値テスト (STUCK_WARN_THRESHOLD=5秒)\n'
WARN_ACTIONS=""
action_warn() {
    local secs="${1:-0}"
    WARN_ACTIONS="warn:${secs}"
}
# heartbeat を 10秒前に更新
HB_OLD="${TMPDIR_TEST}/heartbeat_old"
touch -t "$(date -v-10S '+%Y%m%d%H%M.%S' 2>/dev/null || date -d '10 seconds ago' '+%Y%m%d%H%M.%S' 2>/dev/null || echo '')" "${HB_OLD}" 2>/dev/null || {
    # touch -t が使えない環境: Python で 10秒前 mtime をセット
    python3 -c "import os,time; os.utime('${HB_OLD}', (time.time()-10, time.time()-10))" 2>/dev/null \
        || { printf '  SKIP: mtime操作不可環境\n'; (( SKIP++ )) || true; }
}
if [[ -f "${HB_OLD}" ]]; then
    export HEARTBEAT_FILE="${HB_OLD}"
    export STUCK_WARN_THRESHOLD=5
    export STUCK_KILL_THRESHOLD=9999
    WARN_THRESHOLD=5
    KILL_THRESHOLD=9999
    run_check
    if [[ "${WARN_ACTIONS}" == warn:* ]]; then
        printf '  PASS: 30分閾値テスト — warn action 発火\n'
        (( PASS++ )) || true
    else
        printf '  FAIL: 30分閾値テスト — warn action 未発火 (WARN_ACTIONS=%s)\n' "${WARN_ACTIONS}"
        (( FAIL++ )) || true
    fi
    # 後始末
    export HEARTBEAT_FILE="${TMPDIR_TEST}/heartbeat"
    export STUCK_WARN_THRESHOLD=1800
    export STUCK_KILL_THRESHOLD=5400
    WARN_THRESHOLD=1800
    KILL_THRESHOLD=5400
fi
unset -f action_warn 2>/dev/null || true

# ─── テスト 9: 90分閾値 (STUCK_KILL_THRESHOLD=10) ───────────────────────────
printf '\n[T9] stuck 判定 — 90分閾値テスト (STUCK_KILL_THRESHOLD=10秒)\n'
KILL_ACTIONS=""
action_kill_and_dispatch() {
    local secs="${1:-0}"
    KILL_ACTIONS="kill:${secs}"
}
HB_OLDER="${TMPDIR_TEST}/heartbeat_older"
python3 -c "import os,time; open('${HB_OLDER}','w').close(); os.utime('${HB_OLDER}', (time.time()-20, time.time()-20))" 2>/dev/null || {
    printf '  SKIP: python3 mtime操作不可\n'; (( SKIP++ )) || true
}
if [[ -f "${HB_OLDER}" ]]; then
    export HEARTBEAT_FILE="${HB_OLDER}"
    export STUCK_WARN_THRESHOLD=5
    export STUCK_KILL_THRESHOLD=10
    WARN_THRESHOLD=5
    KILL_THRESHOLD=10
    run_check
    if [[ "${KILL_ACTIONS}" == kill:* ]]; then
        printf '  PASS: 90分閾値テスト — kill action 発火\n'
        (( PASS++ )) || true
    else
        printf '  FAIL: 90分閾値テスト — kill action 未発火 (KILL_ACTIONS=%s)\n' "${KILL_ACTIONS}"
        (( FAIL++ )) || true
    fi
    export HEARTBEAT_FILE="${TMPDIR_TEST}/heartbeat"
    export STUCK_WARN_THRESHOLD=1800
    export STUCK_KILL_THRESHOLD=5400
    export WARN_THRESHOLD=1800
    export KILL_THRESHOLD=5400
fi
unset -f action_kill_and_dispatch 2>/dev/null || true

# ─── テスト 10: dispatch count 管理 ──────────────────────────────────────────
printf '\n[T10] dispatch count — increment / reset\n'
export DISPATCH_COUNT_FILE="${TMPDIR_TEST}/dispatch-count"
rm -f "${DISPATCH_COUNT_FILE}"

c=$(get_dispatch_count); assert_eq "初期count=0" "0" "${c}"
increment_dispatch_count
c=$(get_dispatch_count); assert_eq "increment後=1" "1" "${c}"
increment_dispatch_count
c=$(get_dispatch_count); assert_eq "increment後=2" "2" "${c}"
reset_dispatch_count
c=$(get_dispatch_count); assert_eq "reset後=0" "0" "${c}"

# ─── 結果サマリ ───────────────────────────────────────────────────────────────
printf '\n─────────────────────────────────────────────\n'
printf 'Result: PASS=%d  FAIL=%d  SKIP=%d\n' "${PASS}" "${FAIL}" "${SKIP}"
printf '─────────────────────────────────────────────\n'

if [[ "${FAIL:-0}" -gt 0 ]]; then
    exit 1
fi
exit 0
