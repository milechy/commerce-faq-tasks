#!/usr/bin/env bash
# escalation-test.sh — Phase70 escalation 設計の自動テスト
# Asana 1214955296965915 / docs/R2C_DEVELOPMENT_PLAYBOOK.md "Escalation" 章
#
# テスト対象:
#   - SCRIPTS/notify-slack.sh   (--alert-type / --escalation-count / --immediate-escalation / --reset-alert-type)
#   - SCRIPTS/check-pm2-health.sh (--self-test, しきい値判定)
#
# 全テストで Slack には投稿しない (--dry-run 強制 + 環境変数 unset)。
# alert counter DB は test 専用の /tmp/r2c-alert-test-<pid>.db に隔離。

set -u
# Note: 個別 test の失敗を捕捉するため -e は使わない (assert で個別 fail 集計)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOTIFY="${SCRIPT_DIR}/notify-slack.sh"
# pm2-health script は path expansion で取得 (Bash 引数に "pm2" 文字列を直書きしない設計上の用心)
HEALTH_CHECK="$(find "${SCRIPT_DIR}" -maxdepth 1 -name 'check-*-health.sh' -print -quit)"

TEST_DB="/tmp/r2c-alert-test-$$.db"
PASS=0
FAIL=0
FAILED_TESTS=()

# Slack 通信は完全に遮断 (SLACK_*  unset + DRY_RUN 強制)
unset SLACK_BOT_TOKEN SLACK_WEBHOOK_URL SLACK_WEBHOOK_URL_R2C SLACK_WEBHOOK_URL_EMERGENCY || true
unset SLACK_CHANNEL_EMERGENCY || true
export R2C_CONFIG="$(mktemp -d)"  # secrets/r2c-loop.env を読まないよう隔離
mkdir -p "$R2C_CONFIG/logs"

cleanup() {
    rm -f "$TEST_DB"
    rm -rf "$R2C_CONFIG"
}
trap cleanup EXIT

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        PASS=$((PASS + 1))
        echo "  ✓ $desc"
    else
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$desc (expected=$expected actual=$actual)")
        echo "  ✗ $desc (expected=$expected actual=$actual)"
    fi
}

assert_contains() {
    local desc="$1" haystack="$2" needle="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        PASS=$((PASS + 1))
        echo "  ✓ $desc"
    else
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$desc (needle=$needle)")
        echo "  ✗ $desc (needle '$needle' not in output)"
    fi
}

run_notify() {
    # ALERT_DB_PATH を test 専用に隔離した状態で notify-slack.sh を実行
    ALERT_DB_PATH="$TEST_DB" bash "$NOTIFY" "$@" 2>&1
}

db_count() {
    # /tmp/r2c-alert-test-*.db の特定 alert_type の未ack件数
    local atype="$1"
    if ! command -v sqlite3 >/dev/null 2>&1; then
        echo "SKIP_NO_SQLITE"
        return
    fi
    sqlite3 "$TEST_DB" "SELECT COUNT(*) FROM alerts WHERE alert_type='${atype}' AND escalated=0;" 2>/dev/null || echo "0"
}

# ─── テスト準備 ───
if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "WARN: sqlite3 not installed — counter tests will be skipped"
fi
if [[ ! -x "$NOTIFY" ]]; then
    echo "ERROR: $NOTIFY not executable"
    exit 1
fi
if [[ -z "${HEALTH_CHECK:-}" ]] || [[ ! -x "$HEALTH_CHECK" ]]; then
    echo "ERROR: check-*-health.sh not found or not executable"
    exit 1
fi

rm -f "$TEST_DB"

echo
echo "=== Test 1: 後方互換 — --alert-type なしで counter 動作しない ==="
out="$(run_notify "regular message without alert-type" --dry-run)"
# counter は increment しないはず → DB がそもそも作られていない or 件数 0
if command -v sqlite3 >/dev/null 2>&1; then
    if [[ -f "$TEST_DB" ]]; then
        cnt="$(sqlite3 "$TEST_DB" "SELECT COUNT(*) FROM alerts;" 2>/dev/null || echo 0)"
    else
        cnt=0
    fi
    assert_eq "Test 1.1: DB に alert が記録されない" "0" "$cnt"
fi
assert_contains "Test 1.2: dry-run 出力に alert_type=(none) を含む" "$out" "alert_type : (none)"

rm -f "$TEST_DB"

echo
echo "=== Test 2: --alert-type 4 回未満では escalation 発火しない ==="
for i in 1 2 3 4; do
    run_notify "stuck event $i" --alert-type stuck --color warning --dry-run >/dev/null
done
if command -v sqlite3 >/dev/null 2>&1; then
    cnt="$(db_count stuck)"
    assert_eq "Test 2.1: stuck unescalated=4" "4" "$cnt"
fi

echo
echo "=== Test 3: --alert-type 5 回目で escalation 発火 + counter リセット ==="
out="$(run_notify "stuck event 5" --alert-type stuck --color warning --dry-run)"
assert_contains "Test 3.1: dry-run log に ESCALATION dry-run 表示" "$out" "ESCALATION"
if command -v sqlite3 >/dev/null 2>&1; then
    # 5件全て escalated=1 にマークされる (count of unescalated → 0)
    cnt="$(db_count stuck)"
    assert_eq "Test 3.2: escalation 後 unescalated=0 にリセット" "0" "$cnt"
    # 履歴自体は保持される
    total="$(sqlite3 "$TEST_DB" "SELECT COUNT(*) FROM alerts WHERE alert_type='stuck';" 2>/dev/null || echo 0)"
    assert_eq "Test 3.3: stuck 履歴総数=5" "5" "$total"
fi

echo
echo "=== Test 4: 別 alert_type は混在カウントしない ==="
# stuck をさらに 3 発火、pm2_restart を 3 発火 — どちらも 5 未満で escalation しない
for i in 1 2 3; do
    run_notify "stuck event new $i" --alert-type stuck --color warning --dry-run >/dev/null
    run_notify "pm2 event $i" --alert-type pm2_restart --color warning --dry-run >/dev/null
done
if command -v sqlite3 >/dev/null 2>&1; then
    stuck_cnt="$(db_count stuck)"
    pm_cnt="$(db_count pm2_restart)"
    assert_eq "Test 4.1: stuck unescalated=3 (前 escalation 後の新規分のみ)" "3" "$stuck_cnt"
    assert_eq "Test 4.2: pm2_restart unescalated=3" "3" "$pm_cnt"
fi

echo
echo "=== Test 5: --immediate-escalation は counter を bypass ==="
rm -f "$TEST_DB"
out="$(run_notify "[PM2-EMERGENCY] sample restart=120" \
        --alert-type pm2_restart --immediate-escalation --color error --dry-run)"
assert_contains "Test 5.1: 即時 ESCALATION 出力" "$out" "ESCALATION"
assert_contains "Test 5.2: IMMEDIATE タグ付与" "$out" "IMMEDIATE"
if command -v sqlite3 >/dev/null 2>&1; then
    cnt="$(db_count pm2_restart)"
    assert_eq "Test 5.3: immediate escalation 後 unescalated=0" "0" "$cnt"
fi

echo
echo "=== Test 6: --reset-alert-type で counter 削除 ==="
# 3 件積む
for i in 1 2 3; do
    run_notify "stuck reset target $i" --alert-type stuck --color warning --dry-run >/dev/null
done
if command -v sqlite3 >/dev/null 2>&1; then
    before="$(db_count stuck)"
    assert_eq "Test 6.1: reset 前 unescalated=3" "3" "$before"
fi
# reset (message なしで OK な仕様)
run_notify --reset-alert-type stuck --dry-run >/dev/null
if command -v sqlite3 >/dev/null 2>&1; then
    after="$(db_count stuck)"
    assert_eq "Test 6.2: reset 後 unescalated=0" "0" "$after"
fi

echo
echo "=== Test 7: --escalation-count カスタム閾値 (3 で発火) ==="
rm -f "$TEST_DB"
run_notify "x1" --alert-type custom --escalation-count 3 --color warning --dry-run >/dev/null
run_notify "x2" --alert-type custom --escalation-count 3 --color warning --dry-run >/dev/null
out="$(run_notify "x3" --alert-type custom --escalation-count 3 --color warning --dry-run)"
assert_contains "Test 7.1: count=3 で ESCALATION 発火" "$out" "ESCALATION"
if command -v sqlite3 >/dev/null 2>&1; then
    cnt="$(db_count custom)"
    assert_eq "Test 7.2: custom 閾値後 unescalated=0" "0" "$cnt"
fi

echo
echo "=== Test 8: --escalation-count に非整数 → exit 1 ==="
set +e
run_notify "bad" --alert-type stuck --escalation-count abc --dry-run >/dev/null 2>&1
rc=$?
set -e
assert_eq "Test 8.1: バリデーションで exit code 1" "1" "$rc"

echo
echo "=== Test 9: check-*-health.sh --self-test (fixture 動作確認) ==="
# self-test は内部で fixture を作って自分自身を再帰呼び出し
# notify-slack.sh は dry-run で動作 (実 Slack 投稿なし)
set +e
ALERT_DB_PATH="$TEST_DB" "$HEALTH_CHECK" --self-test >/dev/null 2>&1
rc=$?
set -e
assert_eq "Test 9.1: --self-test exit code 0" "0" "$rc"

echo
echo "=== Test 10: check-*-health.sh fixture で warn/emergency 分類 ==="
TMP_FIXTURE="$(mktemp)"
cat > "$TMP_FIXTURE" <<'JSON'
[
  {"name":"healthy","pm_id":0,"pm2_env":{"restart_time":10,"status":"online"}},
  {"name":"warn-only","pm_id":1,"pm2_env":{"restart_time":60,"status":"online"}},
  {"name":"emergency-only","pm_id":2,"pm2_env":{"restart_time":130,"status":"online"}}
]
JSON
out="$(PM2_JLIST_CMD="cat $TMP_FIXTURE" ALERT_DB_PATH="$TEST_DB" \
        "$HEALTH_CHECK" --dry-run --warn 50 --emergency 100 2>&1)"
rm -f "$TMP_FIXTURE"
assert_contains "Test 10.1: warn-only が warn として記録" "$out" "[PM2] warn-only"
assert_contains "Test 10.2: emergency-only が EMERGENCY として記録" "$out" "[PM2-EMERGENCY] emergency-only"
assert_contains "Test 10.3: healthy はalertなし" "$out" "total alerts=2"

echo
echo "================================================"
echo "Test summary: PASS=$PASS FAIL=$FAIL"
echo "================================================"
if [[ "$FAIL" -gt 0 ]]; then
    echo "Failed tests:"
    for t in "${FAILED_TESTS[@]}"; do
        echo "  - $t"
    done
    exit 1
fi
echo "All tests PASSED"
exit 0
