#!/usr/bin/env bash
# morning-digest.sh — Phase70-C 朝のレビュー受け入れ用ダイジェスト
#
# 用途:
#   夜間 24h 自走で作成した PR 一覧 + Codex review 結果 + リスク色付けを
#   Slack #r2c に投稿し、hkobayashi が 2h 以内にレビュー完結できる情報を提供する。
#
# 参照: docs/MORNING_REVIEW_FLOW.md
#
# 使い方:
#   bash SCRIPTS/morning-digest.sh             # Slack 投稿あり
#   bash SCRIPTS/morning-digest.sh --dry-run   # stdout のみ、Slack 投稿なし
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_ROOT="${R2C_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"
NOTIFY_SLACK="${R2C_ROOT}/SCRIPTS/notify-slack.sh"
SLACK_CHANNEL_ID="C0AG07HFJTB"

# Risk Scorer (Phase70-F): SCRIPTS/pr-risk-scorer.sh を使用
# フォールバック: pr-risk-scorer.sh が存在しない or 失敗時は Tier から推定
RISK_SCORER_PATH="${R2C_ROOT}/SCRIPTS/pr-risk-scorer.sh"
RISK_SCORER_AVAILABLE=0
[[ -x "$RISK_SCORER_PATH" ]] && RISK_SCORER_AVAILABLE=1

DRY_RUN=0

usage() { echo "Usage: $SCRIPT_NAME [--dry-run]"; exit 0; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

command -v gh   >/dev/null 2>&1 || { echo "ERROR: gh CLI required" >&2; exit 1; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq required"    >&2; exit 1; }

mkdir -p "$LOG_DIR"
if [[ "$DRY_RUN" -eq 0 ]]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >&2; }

# 昨日の日付（macOS / Linux 両対応）
YESTERDAY="$(date -v-1d '+%Y-%m-%d' 2>/dev/null || date -d 'yesterday' '+%Y-%m-%d')"

log "morning-digest start (since $YESTERDAY)"

# ─── 1. 夜間 PR 一覧 ───────────────────────────────────────────────
log "Fetching PR list..."
PR_JSON="$(gh pr list \
    --search "created:>$YESTERDAY is:open is:pr" \
    --json number,title,headRefName,labels,statusCheckRollup,additions,deletions \
    --limit 20 2>/dev/null || echo '[]')"

PR_COUNT="$(echo "$PR_JSON" | jq 'length')"
log "Found $PR_COUNT PRs"

# ─── 2. PR ごとの情報整形 ─────────────────────────────────────────
format_risk() {
    local pr_number="$1"
    local labels="$2"
    local additions="$3"
    local deletions="$4"
    local checks_state="$5"

    # Phase70-F Risk Scorer を優先使用、失敗時はフォールバック
    if [[ "$RISK_SCORER_AVAILABLE" -eq 1 ]]; then
        local scorer_json
        scorer_json="$(bash "$RISK_SCORER_PATH" "$pr_number" --json-only --dry-run 2>/dev/null)" || scorer_json=""
        if [[ -n "$scorer_json" ]]; then
            echo "$scorer_json" | jq -r '.risk // "medium"'
            return
        fi
    fi

    # フォールバック: Tier + diff size から推定
    local tier="A"
    if echo "$labels" | grep -q "tier-b\|docs\|script\|test\|risk:low"; then
        tier="B"
    fi

    local diff_size=$(( additions + deletions ))
    local risk="medium"

    if echo "$labels" | grep -q "risk:high"; then
        risk="high"
    elif echo "$labels" | grep -q "risk:low"; then
        risk="low"
    elif [[ "$tier" == "B" ]] && [[ "$checks_state" == "SUCCESS" ]]; then
        risk="low"
    elif [[ "$diff_size" -gt 200 ]] || [[ "$checks_state" != "SUCCESS" ]]; then
        risk="high"
    elif [[ "$diff_size" -le 50 ]]; then
        risk="low-medium"
    fi

    echo "$risk"
}

risk_emoji() {
    case "$1" in
        low)         echo "🟢" ;;
        low-medium)  echo "🟡" ;;
        medium)      echo "🟡" ;;
        medium-high) echo "🟠" ;;
        high)        echo "🔴" ;;
        *)           echo "⚪" ;;
    esac
}

# ─── 3. サマリテキスト生成 ────────────────────────────────────────
SUMMARY_LINES=""
while IFS= read -r pr_line; do
    pr_number="$(echo "$pr_line" | jq -r '.number')"
    pr_title="$(echo "$pr_line"  | jq -r '.title')"
    labels="$(echo "$pr_line"    | jq -r '[.labels[].name] | join(",")')"
    additions="$(echo "$pr_line" | jq -r '.additions')"
    deletions="$(echo "$pr_line" | jq -r '.deletions')"
    checks="$(echo "$pr_line"    | jq -r '.statusCheckRollup // "UNKNOWN"')"
    # statusCheckRollup is an array; derive overall state
    checks_state="$(echo "$pr_line" | jq -r '
        if .statusCheckRollup == null then "UNKNOWN"
        elif (.statusCheckRollup | map(select(.state == "FAILURE")) | length) > 0 then "FAILURE"
        elif (.statusCheckRollup | map(select(.state == "PENDING")) | length) > 0 then "PENDING"
        else "SUCCESS"
        end')"

    risk="$(format_risk "$pr_number" "$labels" "$additions" "$deletions" "$checks_state")"
    emoji="$(risk_emoji "$risk")"

    ci_mark="✅"
    [[ "$checks_state" == "FAILURE" ]] && ci_mark="❌"
    [[ "$checks_state" == "PENDING" ]] && ci_mark="⏳"
    [[ "$checks_state" == "UNKNOWN" ]] && ci_mark="❓"

    line="${emoji} #${pr_number} [${risk}] ${ci_mark} ${pr_title} (+${additions}/-${deletions})"
    SUMMARY_LINES="${SUMMARY_LINES}\n${line}"
done < <(echo "$PR_JSON" | jq -c '.[]')

# ─── 4. Slack 投稿 ────────────────────────────────────────────────
DATE_STR="$(date '+%Y-%m-%d')"
MERGED_COUNT="$(gh pr list --state merged --search "merged:>$YESTERDAY" \
    --json number -q 'length' 2>/dev/null || echo '0')"

SLACK_TEXT="*🌅 ${DATE_STR} 朝のダイジェスト*
夜間作成 PR: *${PR_COUNT}* 件 / 自動マージ済: *${MERGED_COUNT}* 件

*PR 一覧（リスク順）:*$(printf '%b' "$SUMMARY_LINES")

🟢=low  🟡=medium  🔴=high
詳細: \`bash SCRIPTS/morning-digest.sh --dry-run\` で再表示
レビュー手順: docs/MORNING_REVIEW_FLOW.md"

if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s\n' "$SLACK_TEXT"
else
    if [[ -x "$NOTIFY_SLACK" ]]; then
        "$NOTIFY_SLACK" "$SLACK_TEXT" --color info
    else
        log "WARN: notify-slack.sh not found, printing to stdout"
        printf '%s\n' "$SLACK_TEXT"
    fi
fi

log "morning-digest done"
