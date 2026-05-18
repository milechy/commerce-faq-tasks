#!/usr/bin/env bash
# 24h-mode-on.sh — 24h 自走モード ON
#
# Phase70-A: 24h 自走の安全装置 (論理層)
#
# 機能:
#   1. main branch protection を有効化 (PRレビュー1必須/admin含むdirect push禁止)
#   2. repository allow_auto_merge OFF
#   3. 既存 open PR の auto-merge フラグ解除
#   4. ~/.r2c-24h-mode に R2C_24H_MODE=1 + 起動時刻を書く
#   5. Slack #r2c にモード ON 通知
#   6. Cloudflare Pages の手動停止手順を出力 (自動化はしない)
#
# 冪等性:
#   既に ON 状態 (~/.r2c-24h-mode 存在) なら何もせず exit 0
#
# Usage:
#   bash SCRIPTS/24h-mode-on.sh
#   bash SCRIPTS/24h-mode-on.sh --dry-run
#
# 環境変数:
#   GH_REPO              — owner/repo (default: milechy/commerce-faq-tasks)
#   STATUS_CHECKS        — required status checks (CSV, default: "Stream Path Check,Security Scan")
#   SLACK_WEBHOOK_URL    — Slack incoming webhook (なければ通知スキップ)
#   R2C_24H_MODE_FILE    — モードファイルパス (default: $HOME/.r2c-24h-mode)
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help)
            sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "ERROR: unknown arg: $arg" >&2; exit 1 ;;
    esac
done

GH_REPO="${GH_REPO:-milechy/commerce-faq-tasks}"
STATUS_CHECKS="${STATUS_CHECKS:-Stream Path Check,Security Scan}"
MODE_FILE="${R2C_24H_MODE_FILE:-$HOME/.r2c-24h-mode}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[24h-mode-on] %s\n' "$*"; }
run() {
    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '[dry-run] %s\n' "$*"
    else
        eval "$@"
    fi
}

# ─── 冪等チェック ───
if [[ -f "$MODE_FILE" ]]; then
    log "Already ON (found $MODE_FILE) — exit 0"
    cat "$MODE_FILE"
    exit 0
fi

# ─── 依存チェック ───
command -v gh >/dev/null 2>&1 || { echo "ERROR: gh CLI required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 1; }

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── 1. main branch protection ON ───
log "Enabling branch protection on $GH_REPO main…"

CHECKS_JSON=$(printf '%s' "$STATUS_CHECKS" | jq -Rcs 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map({context: ., app_id: -1})')

PROTECTION_PAYLOAD=$(jq -nc \
    --argjson checks "$CHECKS_JSON" \
    '{
        required_status_checks: { strict: true, checks: $checks },
        enforce_admins: true,
        required_pull_request_reviews: {
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            required_approving_review_count: 1
        },
        restrictions: null,
        required_linear_history: false,
        allow_force_pushes: false,
        allow_deletions: false,
        required_conversation_resolution: true
    }')

if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] gh api -X PUT repos/%s/branches/main/protection --input <payload>\n' "$GH_REPO"
    echo '[dry-run] payload:'
    printf '%s' "$PROTECTION_PAYLOAD" | jq .
else
    if ! printf '%s' "$PROTECTION_PAYLOAD" | gh api -X PUT "repos/$GH_REPO/branches/main/protection" --input - >/tmp/24h-mode-on-protection.json 2>&1; then
        echo "ERROR: failed to enable branch protection. gh CLI may lack admin permission." >&2
        echo "  Manual setup: https://github.com/$GH_REPO/settings/branches" >&2
        cat /tmp/24h-mode-on-protection.json >&2
        exit 1
    fi
    log "  ✓ branch protection ON"
fi

# ─── 2. repository allow_auto_merge OFF ───
log "Disabling repository auto-merge…"
run "gh api -X PATCH 'repos/$GH_REPO' -f allow_auto_merge=false >/dev/null"
log "  ✓ allow_auto_merge=false"

# ─── 3. 既存 open PR の auto-merge 解除 ───
log "Disabling auto-merge on existing open PRs…"
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] gh pr list --repo %s --state open --json number,autoMergeRequest --jq <filter>\n' "$GH_REPO"
else
    AUTO_PRS=$(gh pr list --repo "$GH_REPO" --state open --json number,autoMergeRequest --jq '.[] | select(.autoMergeRequest != null) | .number' || echo "")
    if [[ -n "$AUTO_PRS" ]]; then
        while IFS= read -r pr_num; do
            [[ -z "$pr_num" ]] && continue
            log "  disabling auto-merge on PR #$pr_num"
            gh pr merge "$pr_num" --repo "$GH_REPO" --disable-auto || log "    WARN: failed (PR may not have auto-merge)"
        done <<< "$AUTO_PRS"
    else
        log "  ✓ no PRs with auto-merge enabled"
    fi
fi

# ─── 4. モードファイル作成 ───
log "Writing mode file: $MODE_FILE"
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] write %s with:\n  R2C_24H_MODE=1\n  R2C_24H_MODE_STARTED_AT=%s\n' "$MODE_FILE" "$NOW_ISO"
else
    cat > "$MODE_FILE" <<EOF
R2C_24H_MODE=1
R2C_24H_MODE_STARTED_AT=$NOW_ISO
EOF
    chmod 600 "$MODE_FILE"
    log "  ✓ mode file created (perm 600)"
fi

# ─── 5. Slack 通知 ───
SLACK_HELPER="$SCRIPT_DIR/r2c-slack-notify.sh"
SLACK_MSG="🔒 *R2C 24h 自走モード ON* — 起動時刻 \`$NOW_ISO\` (repo: $GH_REPO)"
if [[ -x "$SLACK_HELPER" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '[dry-run] %s --text %q\n' "$SLACK_HELPER" "$SLACK_MSG"
    else
        if ! "$SLACK_HELPER" --text "$SLACK_MSG" 2>/dev/null; then
            log "  WARN: Slack notify failed (continuing)"
        else
            log "  ✓ Slack notified"
        fi
    fi
else
    log "  WARN: $SLACK_HELPER not executable — skipping Slack notify"
fi

# ─── 6. Cloudflare Pages 手動停止手順 ───
cat <<'CF'

────────────────────────────────────────────────────────
⚠️  手動操作必須: Cloudflare Pages auto-deploy 停止
────────────────────────────────────────────────────────
  1. https://dash.cloudflare.com にログイン
  2. Workers & Pages → admin-r2c (Pages project) を選択
  3. Settings → Builds & deployments
  4. "Production branch" の "Pause deployments" を ON
  5. 解除は SCRIPTS/24h-mode-off.sh 実行後に同画面で OFF
────────────────────────────────────────────────────────
CF

log "Done. 24h-mode is ON."
