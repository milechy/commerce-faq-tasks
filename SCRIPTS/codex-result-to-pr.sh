#!/usr/bin/env bash
# codex-result-to-pr.sh — Phase70-C
#
# PR 作成後に /codex:review --base main --background を起動し、
# 完了後に結果を PR コメントに貼り付ける。
#
# 参照: docs/MORNING_REVIEW_FLOW.md §Step3 / CLAUDE.md Gate 2.5
#
# 使い方:
#   bash SCRIPTS/codex-result-to-pr.sh <PR番号>
#   bash SCRIPTS/codex-result-to-pr.sh <PR番号> --dry-run
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_ROOT="${R2C_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"

DRY_RUN=0
PR_NUMBER=""

usage() {
    echo "Usage: $SCRIPT_NAME <PR番号> [--dry-run]"
    echo "  PR番号: gh pr list で確認できる数字"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage ;;
        [0-9]*) PR_NUMBER="$1"; shift ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

[[ -z "$PR_NUMBER" ]] && { echo "ERROR: PR番号を指定してください" >&2; usage; exit 1; }

command -v gh     >/dev/null 2>&1 || { echo "ERROR: gh CLI required" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI required" >&2; exit 1; }

mkdir -p "$LOG_DIR"
if [[ "$DRY_RUN" -eq 0 ]]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >&2; }

# ─── PR のブランチ名確認 ───────────────────────────────────────────
log "Checking PR #$PR_NUMBER..."
PR_BRANCH="$(gh pr view "$PR_NUMBER" --json headRefName -q '.headRefName' 2>/dev/null)"
if [[ -z "$PR_BRANCH" ]]; then
    echo "ERROR: PR #$PR_NUMBER が見つかりません" >&2
    exit 1
fi
log "PR #$PR_NUMBER branch: $PR_BRANCH"

# ─── Codex review 実行 (--background) ───────────────────────────────
CODEX_OUTPUT_FILE="${LOG_DIR}/codex-review-pr${PR_NUMBER}.txt"

log "Running: /codex:review --base main --background for PR #$PR_NUMBER"

if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[DRY-RUN] Would run codex review and post to PR #$PR_NUMBER"
    exit 0
fi

# CLAUDE.md Gate 2.5: /codex:review --base main --background
# claude CLI 経由で実行（スキルとして呼び出し）
set +e
claude --print "/codex:review --base main" > "$CODEX_OUTPUT_FILE" 2>&1
CODEX_EXIT=$?
set -e

if [[ ! -s "$CODEX_OUTPUT_FILE" ]]; then
    log "WARN: Codex review output is empty, using fallback message"
    echo "Codex review が結果を返しませんでした（Gate 2.5 スキップ対象の可能性）" > "$CODEX_OUTPUT_FILE"
fi

# ─── 結果を PR コメントに投稿 ────────────────────────────────────────
CODEX_RESULT="$(cat "$CODEX_OUTPUT_FILE")"
COMMENT_BODY="## 🤖 Codex Review 結果 (Gate 2.5)

\`\`\`
$(echo "$CODEX_RESULT" | head -100)
\`\`\`

> 実行日時: $(date '+%Y-%m-%d %H:%M JST')
> スクリプト: SCRIPTS/codex-result-to-pr.sh
> 参照: docs/MORNING_REVIEW_FLOW.md §Step3"

log "Posting Codex result to PR #$PR_NUMBER..."
gh pr comment "$PR_NUMBER" --body "$COMMENT_BODY"

log "codex-result-to-pr.sh done for PR #$PR_NUMBER (exit: $CODEX_EXIT)"
