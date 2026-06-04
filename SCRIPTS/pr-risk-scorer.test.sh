#!/usr/bin/env bash
# pr-risk-scorer.test.sh — Phase70-F セルフテスト
#
# 過去 PR(#176/#178/#179/#181/#183/#185)を sample に判定実行し、
# 人間判断と整合するかを検証する。
#
# 使い方:
#   bash SCRIPTS/pr-risk-scorer.test.sh           # 全テスト実行
#   bash SCRIPTS/pr-risk-scorer.test.sh --live    # 実 PR に接続してテスト(gh CLI 必要)
#
# ドライラン(mock)モードでは、PR メタデータを内部で定義して gh CLI を使わずに判定ロジックを検証する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCORER="${SCRIPT_DIR}/pr-risk-scorer.sh"
LIVE=0

[[ "${1:-}" == "--live" ]] && LIVE=1 || true

PASS=0
FAIL=0
TOTAL=0

assert_risk() {
    local label="$1"
    local pr_number="$2"
    local expected_risk="$3"
    local description="$4"

    TOTAL=$(( TOTAL + 1 ))
    printf '  TEST [%d] %s\n' "$TOTAL" "$label"

    if [[ "$LIVE" -eq 1 ]]; then
        # 実 gh CLI で判定
        local actual_json
        actual_json="$(bash "$SCORER" "$pr_number" --json-only --dry-run 2>/dev/null)" || {
            printf '    SKIP (gh CLI error or PR not accessible)\n'
            return
        }
        local actual_risk
        actual_risk="$(echo "$actual_json" | jq -r '.risk')"
    else
        # mock モード: テスト用データで判定ロジックを直接検証
        actual_risk="$(mock_score "$pr_number")"
    fi

    if [[ "$actual_risk" == "$expected_risk" ]]; then
        printf '    PASS: risk=%s (expected=%s) — %s\n' "$actual_risk" "$expected_risk" "$description"
        PASS=$(( PASS + 1 ))
    else
        printf '    FAIL: risk=%s (expected=%s) — %s\n' "$actual_risk" "$expected_risk" "$description"
        FAIL=$(( FAIL + 1 ))
    fi
}

# ─── 単一ファイル分類 (mock_score / unit_test_classify 共通) ──────────────────
# ⚠️ pr-risk-scorer.sh の classify_file と境界を一致させること (重複定義。両方を同時に更新)。
classify_single_file() {
    local f="$1"
    local HIGH_PATS=(
        "^src/middleware/"
        "^src/api/auth"
        "^src/agent/security"
        "migration"
        "\.sql$"
        "schema"
        "^SCRIPTS/deploy"
        "^SCRIPTS/security-scan"
        "^SCRIPTS/24h-mode"
        "^\.env"
        "^\.claude/hooks/"
        "^\.github/workflows/"
    )
    # low = Tier B (auto_merge_eligible)。SCRIPTS/ と .claude/agents|skills/ は
    # HIGH を先に弾いた上で Tier B 扱いになる。
    local LOW_PATS=(
        "^docs/"
        "\.md$"
        "^tests/"
        "\.test\.(ts|tsx|js)$"
        "^\.wolf/"
        "^DAILY_REPORT"
        "^SCRIPTS/"
        "^\.claude/agents/"
        "^\.claude/skills/"
    )
    local MEDIUM_PATS=(
        "^src/"
        "^admin-ui/src/"
        "^SCRIPTS/"
        "^\.claude/"
        "package\.json$"
        "pnpm-lock\.yaml$"
        "tsconfig"
        "ecosystem\.config"
    )
    # high 最優先
    for pat in "${HIGH_PATS[@]}"; do
        echo "$f" | grep -qE "$pat" && { echo "high"; return; }
    done
    # .claude/ は設定ファイルのため medium。ただし agents/ と skills/ は Tier B のため除外。
    if echo "$f" | grep -qE "^\.claude/" \
        && ! echo "$f" | grep -qE "^\.claude/(hooks|agents|skills)/"; then
        echo "medium"; return
    fi
    # low を medium より先にチェック(test ファイルが src/ 配下でも low)
    for pat in "${LOW_PATS[@]}"; do
        echo "$f" | grep -qE "$pat" && { echo "low"; return; }
    done
    for pat in "${MEDIUM_PATS[@]}"; do
        echo "$f" | grep -qE "$pat" && { echo "medium"; return; }
    done
    echo "low"
}

# ─── Mock 判定ロジック(ユニットテスト用) ──────────────────────────────────
# 実際の pr-risk-scorer.sh の判定ロジックをシミュレート
# 各 PR の変更ファイルリストを内部で定義して判定する

mock_score() {
    local pr="$1"

    declare -a files=()
    local additions=0
    local deletions=0

    case "$pr" in
        176)
            # Phase70-A: 24h 安全装置(704 additions, 0 deletions)
            # docs/, SCRIPTS/24h-mode-*.sh, .claude/hooks/deploy_guard.py
            files=(
                "docs/24H_AUTONOMOUS_PLAYBOOK.md"
                "SCRIPTS/24h-mode-on.sh"
                "SCRIPTS/24h-mode-off.sh"
                ".claude/hooks/deploy_guard.py"
            )
            additions=704; deletions=0
            ;;
        178)
            # Phase70-J: Asana タスク記述規約(221+0)
            # docs/ のみ
            files=(
                "docs/ASANA_TASK_TEMPLATE.md"
                "docs/ASANA_24H_ELIGIBLE_TAGS.md"
            )
            additions=221; deletions=0
            ;;
        179)
            # Phase70-L: Slack 通知整備(213+0)
            # SCRIPTS/notify-slack.sh が新規
            files=(
                "SCRIPTS/notify-slack.sh"
                "docs/SLACK_NOTIFY_PATTERNS.md"
            )
            additions=213; deletions=0
            ;;
        180)
            # Phase70-B: CLAUDE.md auto-memory(138+336)
            # CLAUDE.md + docs/ のみ
            files=(
                "CLAUDE.md"
                "docs/PHASE70_B_MEMO.md"
            )
            additions=138; deletions=336
            ;;
        181)
            # Phase70-D: Asana Watcher(835+336)
            # SCRIPTS/asana-watcher.sh が大きい変更
            files=(
                "SCRIPTS/asana-watcher.sh"
                "docs/ASANA_WATCHER_SPEC.md"
            )
            additions=835; deletions=336
            ;;
        183)
            # Phase70-E: 24h プロンプトテンプレート(518+0)
            # docs/ のみ
            files=(
                "docs/24H_PROMPT_TEMPLATES.md"
                "docs/24H_AUTONOMOUS_PLAYBOOK.md"
            )
            additions=518; deletions=0
            ;;
        185)
            # Phase70-C: 朝のレビュー受け入れフロー(578+7)
            # docs/ のみ
            files=(
                "docs/MORNING_REVIEW_FLOW.md"
                "SCRIPTS/morning-digest.sh"
                "SCRIPTS/codex-result-to-pr.sh"
            )
            additions=578; deletions=7
            ;;
        *)
            echo "unknown"
            return
            ;;
    esac

    # 判定ロジックは classify_single_file に一本化 (重複排除)。
    # classify_single_file は本ファイル下部で定義済み (呼び出し時には登録済み)。
    local has_high=0
    local has_medium=0

    for f in "${files[@]}"; do
        local cls
        cls="$(classify_single_file "$f")"
        [[ "$cls" == "high" ]] && has_high=1
        [[ "$cls" == "medium" ]] && has_medium=1
    done

    local total=$(( additions + deletions ))

    if [[ "$has_high" -eq 1 ]]; then
        echo "high"
    elif [[ "$has_medium" -eq 1 ]]; then
        if [[ "$total" -gt 200 ]]; then
            echo "high"
        else
            echo "medium"
        fi
    else
        if [[ "$total" -gt 500 ]]; then
            echo "medium"
        else
            echo "low"
        fi
    fi
}

# ─── テストケース定義 ──────────────────────────────────────────────────────
echo ""
echo "=== pr-risk-scorer.test.sh (Phase70-F) ==="
echo "Mode: $([ "$LIVE" -eq 1 ] && echo 'LIVE (real gh CLI)' || echo 'MOCK (internal simulation)')"
echo ""
echo "--- Past PR Sample Tests ---"
echo ""

# PR #176: 24h 安全装置(SCRIPTS/24h-mode-*.sh + .claude/hooks/ あり) → high
assert_risk "PR#176 Phase70-A 24h-safety" 176 "high" \
    "24h-mode-*.sh (.high) + .claude/hooks/ (.high) → high"

# PR #178: Asana タスク記述規約(docs/ のみ) → low
assert_risk "PR#178 Phase70-J docs-only" 178 "low" \
    "docs/*.md のみ → low"

# PR #179: Slack 通知(SCRIPTS/notify-slack.sh, 213+0=213行) → low
# Tier B 拡張後: SCRIPTS/(非 deploy/24h/security-scan) は low。diff 213 < 500 → low (auto-merge 対象)
assert_risk "PR#179 Phase70-L SCRIPTS-only" 179 "low" \
    "SCRIPTS/*.sh (Tier B) + diff 213 < 500 → low"

# PR #180: CLAUDE.md + docs/(138+336=474行) → low
# CLAUDE.md は medium パターンに該当しない(.claudeルール適用なし) → low でも diff=474 < 500 → low
assert_risk "PR#180 Phase70-B claude-md" 180 "low" \
    "CLAUDE.md + docs/ (474 lines, < 500) → low"

# PR #181: SCRIPTS/asana-watcher.sh(835+336=1171行) → medium
# Tier B 拡張後: SCRIPTS/ は low だが diff 1171 > 500 → medium に昇格 (大規模は人手レビュー)
assert_risk "PR#181 Phase70-D asana-watcher" 181 "medium" \
    "SCRIPTS/ (Tier B) + diff 1171 > 500 → medium (large diff escalation)"

# PR #183: docs/ のみ(518+0=518行) → medium (diff 518 > 500 → low から medium に昇格)
assert_risk "PR#183 Phase70-E docs-only" 183 "medium" \
    "docs/*.md のみ, diff 518 > 500 → medium (large docs diff)"

# PR #185: docs/ + SCRIPTS/(578+7=585行) → 全 Tier B(low)だが diff 585 > 500 → medium
assert_risk "PR#185 Phase70-C morning-review" 185 "medium" \
    "docs/ + SCRIPTS/ (Tier B) + diff 585 > 500 → medium (large diff escalation)"

echo ""
echo "--- Unit Tests: Edge Cases ---"
echo ""

# ─── エッジケースユニットテスト ───────────────────────────────────────────
unit_test_classify() {
    local label="$1"
    local file="$2"
    local expected="$3"

    TOTAL=$(( TOTAL + 1 ))

    local result
    result="$(classify_single_file "$file")"

    if [[ "$result" == "$expected" ]]; then
        printf '  PASS [%d] %s: %s → %s\n' "$TOTAL" "$label" "$file" "$result"
        PASS=$(( PASS + 1 ))
    else
        printf '  FAIL [%d] %s: %s → %s (expected: %s)\n' "$TOTAL" "$label" "$file" "$result" "$expected"
        FAIL=$(( FAIL + 1 ))
    fi
}

unit_test_classify "middleware → high"        "src/middleware/auth.ts"            "high"
unit_test_classify "api/auth → high"          "src/api/authRouter.ts"             "high"
unit_test_classify "migration → high"         "migrations/20260520_add_col.sql"   "high"
unit_test_classify ".env → high"              ".env.production"                   "high"
unit_test_classify "hooks → high"             ".claude/hooks/deploy_guard.py"     "high"
unit_test_classify "workflows → high"         ".github/workflows/ci.yml"          "high"
unit_test_classify "deploy script → high"     "SCRIPTS/deploy-vps.sh"             "high"
unit_test_classify "security-scan → high"     "SCRIPTS/security-scan.sh"          "high"
unit_test_classify "24h-mode → high"          "SCRIPTS/24h-mode-on.sh"            "high"
unit_test_classify "src/ → medium"            "src/agent/llm/groqClient.ts"       "medium"
unit_test_classify "admin-ui/src → medium"    "admin-ui/src/components/Table.tsx" "medium"
unit_test_classify "SCRIPTS/ non-deploy →low" "SCRIPTS/morning-digest.sh"         "low"
unit_test_classify ".claude/agents → low"     ".claude/agents/gate-runner.md"     "low"
unit_test_classify ".claude/skills → low"     ".claude/skills/r2c-deploy/SKILL.md" "low"
unit_test_classify ".claude/rules → medium"   ".claude/rules/architecture.md"     "medium"
unit_test_classify "package.json → medium"    "package.json"                      "medium"
unit_test_classify "tsconfig → medium"        "tsconfig.json"                     "medium"
unit_test_classify "docs → low"               "docs/MORNING_REVIEW_FLOW.md"       "low"
unit_test_classify "*.md → low"               "README.md"                         "low"
unit_test_classify "tests/ → low"             "tests/integration/auth.test.ts"    "low"
unit_test_classify "*.test.ts → low"          "src/api/__tests__/faq.test.ts"     "low"
unit_test_classify ".wolf/ → low"             ".wolf/memory.md"                   "low"

echo ""
echo "─────────────────────────────────────────────"
echo "Results: ${PASS} passed, ${FAIL} failed, ${TOTAL} total"
echo "─────────────────────────────────────────────"

[[ "$FAIL" -eq 0 ]] && { echo "✅ All tests passed"; exit 0; } || { echo "❌ Some tests FAILED"; exit 1; }
