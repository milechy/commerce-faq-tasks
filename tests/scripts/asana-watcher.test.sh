#!/usr/bin/env bash
# tests/scripts/asana-watcher.test.sh
# asana-watcher.sh の pagination + フィルタロジックをユニットテスト（mock-file モード）
# Phase70-D Codex Round 1 P1 対応: 100件超のページネーション動作確認を含む
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SCRIPT="${REPO_ROOT}/SCRIPTS/asana-watcher.sh"
TMPDIR_TEST="$(mktemp -d)"
PASS=0
FAIL=0

ELIGIBLE_TAG_GID="1214922984195645"

cleanup() { rm -rf "${TMPDIR_TEST}"; }
trap cleanup EXIT

ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

chk_eq() {
    local label="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then
        ok "${label} = ${want}"
    else
        fail "${label}: expected ${want}, got ${got}"
    fi
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Case 1: 単一ページ mock — eligible/skipped カウント確認
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 1: 単一ページ mock — 3タスク(Tier B/A+tag/S), next_page: null"
MOCK1="${TMPDIR_TEST}/mock1.json"
cat > "$MOCK1" <<EOF
{
  "data": [
    {"gid":"t1","name":"Task 1","notes":"Tier: B\n","due_on":null,"completed":false,"permalink_url":"https://app.asana.com/t/1","modified_at":"2026-05-19T10:00:00.000Z","tags":[]},
    {"gid":"t2","name":"Task 2","notes":"Tier: A\n","due_on":null,"completed":false,"permalink_url":"https://app.asana.com/t/2","modified_at":"2026-05-19T10:00:00.000Z","tags":[{"gid":"${ELIGIBLE_TAG_GID}","name":"24h-eligible"}]},
    {"gid":"t3","name":"Task 3","notes":"Tier: S\n","due_on":null,"completed":false,"permalink_url":"https://app.asana.com/t/3","modified_at":"2026-05-19T10:00:00.000Z","tags":[]}
  ],
  "next_page": null
}
EOF
OUTPUT1=$(bash "$SCRIPT" --mock-file "$MOCK1" 2>/dev/null)
chk_eq "total_open" "$(printf '%s' "$OUTPUT1" | jq '.total_open')" "3"
chk_eq "eligible_count" "$(printf '%s' "$OUTPUT1" | jq '.eligible_count')" "2"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Case 2: 2ページ mock — 100件超の全件取得確認
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 2: 2ページ mock — page1=100件 + page2=5件 → total_open=105"
MOCK2="${TMPDIR_TEST}/mock2.json"
MOCK2P2="${TMPDIR_TEST}/mock2-p2.json"

# page1: 100件 Tier B + next_page.offset
jq -n '[range(1; 101) | {
    gid: ("p1_task_\(.)"),
    name: "P1 Task \(.)",
    notes: "Tier: B\n",
    due_on: null,
    completed: false,
    permalink_url: "https://app.asana.com/t/p1_\(.)",
    modified_at: "2026-05-19T10:00:00.000Z",
    tags: []
}] | {
    data: .,
    next_page: {
        offset: "mock_cursor_page2",
        path: "/tasks?offset=mock_cursor_page2",
        uri: "https://app.asana.com/api/1.0/tasks?offset=mock_cursor_page2"
    }
}' > "$MOCK2"

# page2: 5件 Tier B + next_page: null
jq -n '[range(101; 106) | {
    gid: ("p2_task_\(.)"),
    name: "P2 Task \(.)",
    notes: "Tier: B\n",
    due_on: null,
    completed: false,
    permalink_url: "https://app.asana.com/t/p2_\(.)",
    modified_at: "2026-05-19T10:00:00.000Z",
    tags: []
}] | {
    data: .,
    next_page: null
}' > "$MOCK2P2"

OUTPUT2=$(bash "$SCRIPT" --mock-file "$MOCK2" 2>/dev/null)
chk_eq "total_open" "$(printf '%s' "$OUTPUT2" | jq '.total_open')" "105"
chk_eq "eligible_count" "$(printf '%s' "$OUTPUT2" | jq '.eligible_count')" "105"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Case 3: --verbose でページ数ログ確認
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 3: --verbose でページ数ログ出力確認 (stderr)"
VERBOSE_TMP="${TMPDIR_TEST}/verbose.log"
bash "$SCRIPT" --mock-file "$MOCK2" --verbose >/dev/null 2>"$VERBOSE_TMP"

if grep -q "Page 1:" "$VERBOSE_TMP"; then
    ok "--verbose に 'Page 1:' ログ含む"
else
    fail "--verbose に 'Page 1:' ログなし"
fi
if grep -q "Page 2:" "$VERBOSE_TMP"; then
    ok "--verbose に 'Page 2:' ログ含む"
else
    fail "--verbose に 'Page 2:' ログなし"
fi
if grep -q "Pagination exhausted" "$VERBOSE_TMP"; then
    ok "--verbose に 'Pagination exhausted' ログ含む"
else
    fail "--verbose に 'Pagination exhausted' ログなし"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Case 4: --limit が pagination 後の eligible に適用されることを確認
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 4: --limit 3 で 105件 eligible から上位 3 件に制限"
OUTPUT4=$(bash "$SCRIPT" --mock-file "$MOCK2" --limit 3 2>/dev/null)
chk_eq "tasks length with --limit 3" "$(printf '%s' "$OUTPUT4" | jq '.tasks | length')" "3"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Case 5: mock file 不在 → exit 5
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 5: mock file 不在 → exit 5"
MOCK_EXIT=0
bash "$SCRIPT" --mock-file "${TMPDIR_TEST}/nonexistent.json" >/dev/null 2>&1 || MOCK_EXIT=$?
chk_eq "exit code for missing mock" "$MOCK_EXIT" "5"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Case 6: DB migration キーワードを含む Tier B タスク → skipped
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 6: DB migration キーワード含む Tier B → skipped (reason=db_migration)"
MOCK6="${TMPDIR_TEST}/mock6.json"
cat > "$MOCK6" <<'JSONEOF'
{
  "data": [
    {"gid":"mig1","name":"DB migration task","notes":"Tier: B\nmigration script needed","due_on":null,"completed":false,"permalink_url":"https://app.asana.com/t/mig1","modified_at":"2026-05-19T10:00:00.000Z","tags":[]}
  ],
  "next_page": null
}
JSONEOF
OUTPUT6=$(bash "$SCRIPT" --mock-file "$MOCK6" 2>/dev/null)
chk_eq "eligible_count for db_migration task" "$(printf '%s' "$OUTPUT6" | jq '.eligible_count')" "0"
chk_eq "skipped reason" "$(printf '%s' "$OUTPUT6" | jq -r '.skipped[0].reason')" "db_migration"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Case 7: --dry-run で stderr サマリ出力、stdout は valid JSON
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 7: --dry-run で stderr に DRY-RUN summary、stdout は valid JSON"
DRY_STDOUT="${TMPDIR_TEST}/dry_out.json"
DRY_STDERR="${TMPDIR_TEST}/dry_err.log"
bash "$SCRIPT" --mock-file "$MOCK1" --dry-run >"$DRY_STDOUT" 2>"$DRY_STDERR"
if grep -q "DRY-RUN summary" "$DRY_STDERR"; then
    ok "--dry-run に 'DRY-RUN summary' ログ含む"
else
    fail "--dry-run に 'DRY-RUN summary' ログなし"
fi
if jq -e '.tasks' < "$DRY_STDOUT" >/dev/null 2>&1; then
    ok "--dry-run の stdout は valid JSON (.tasks あり)"
else
    fail "--dry-run の stdout が parse 不可"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 結果サマリー
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "=== テスト結果: PASS=${PASS} FAIL=${FAIL} ==="
[ "${FAIL}" -eq 0 ] && echo "全テスト通過" && exit 0
echo "${FAIL}件失敗" && exit 1
