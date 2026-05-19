#!/usr/bin/env bash
# 24h-mode-off.sh — 24h 自走モード OFF
#
# Phase70-A: 24h 自走の安全装置 (論理層) — on.sh の全逆操作
#
# 機能:
#   1. main branch protection を削除
#   2. repository allow_auto_merge ON 復帰
#   3. ~/.r2c-24h-mode を削除
#   4. Slack #r2c にモード OFF 通知
#   5. Cloudflare Pages の再開手順を出力
#
# 冪等性:
#   モードファイルが無い場合は warn を出して続行 (リソース側の clean-up は試みる)
#
# Usage:
#   bash SCRIPTS/24h-mode-off.sh
#   bash SCRIPTS/24h-mode-off.sh --dry-run
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
MODE_FILE="${R2C_24H_MODE_FILE:-$HOME/.r2c-24h-mode}"
BACKUP_FILE="${HOME}/.r2c-24h-mode-protection-backup.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[24h-mode-off] %s\n' "$*"; }
run() {
    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf '[dry-run] %s\n' "$*"
    else
        eval "$@"
    fi
}

command -v gh >/dev/null 2>&1 || { echo "ERROR: gh CLI required" >&2; exit 1; }

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -f "$MODE_FILE" ]]; then
    log "WARN: $MODE_FILE not found (mode may already be OFF). Continuing cleanup…"
else
    log "Found mode file: $MODE_FILE"
fi

# ─── 1. branch protection 復元 (P2: on.sh バックアップから元設定を復元) ───
log "Restoring branch protection on $GH_REPO main…"
if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ -f "$BACKUP_FILE" ]]; then
        printf '[dry-run] restore branch protection from %s\n' "$BACKUP_FILE"
    else
        printf '[dry-run] gh api -X DELETE repos/%s/branches/main/protection (no backup found)\n' "$GH_REPO"
    fi
else
    if [[ -f "$BACKUP_FILE" ]]; then
        if jq -e '.no_protection == true' "$BACKUP_FILE" >/dev/null 2>&1; then
            # 24h-mode 有効化前に protection がなかった → 削除して元の状態に戻す
            if gh api -X DELETE "repos/$GH_REPO/branches/main/protection" >/dev/null 2>&1; then
                log "  ✓ branch protection removed (was none before 24h-mode)"
            else
                log "  WARN: failed to remove (may already be off)"
            fi
        else
            # 元の protection 設定を PUT 形式に変換して復元
            RESTORE_PAYLOAD=$(jq '{
                required_status_checks: .required_status_checks,
                enforce_admins: (.enforce_admins.enabled // false),
                required_pull_request_reviews: .required_pull_request_reviews,
                restrictions: .restrictions,
                required_linear_history: (.required_linear_history.enabled // false),
                allow_force_pushes: (.allow_force_pushes.enabled // false),
                allow_deletions: (.allow_deletions.enabled // false)
            }' "$BACKUP_FILE")
            if printf '%s' "$RESTORE_PAYLOAD" | gh api -X PUT "repos/$GH_REPO/branches/main/protection" --input - >/dev/null 2>&1; then
                log "  ✓ branch protection restored from backup"
            else
                log "  WARN: restore failed — falling back to DELETE"
                gh api -X DELETE "repos/$GH_REPO/branches/main/protection" >/dev/null 2>&1 || true
            fi
        fi
        rm -f "$BACKUP_FILE"
        log "  ✓ backup file removed"
    else
        # バックアップなし (on.sh が古い版の場合など) → 従来通り削除
        if gh api -X DELETE "repos/$GH_REPO/branches/main/protection" >/dev/null 2>&1; then
            log "  ✓ branch protection removed (no backup found)"
        else
            log "  WARN: failed to remove (may already be off, or admin permission missing)"
        fi
    fi
fi

# ─── 2. allow_auto_merge 復帰 ───
log "Re-enabling repository auto-merge…"
run "gh api -X PATCH 'repos/$GH_REPO' -f allow_auto_merge=true >/dev/null"
log "  ✓ allow_auto_merge=true"

# ─── 3. モードファイル削除 ───
log "Removing mode file: $MODE_FILE"
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] rm -f %s\n' "$MODE_FILE"
else
    rm -f "$MODE_FILE"
    log "  ✓ mode file removed"
fi

# ─── 4. Slack 通知 ───
SLACK_HELPER="$SCRIPT_DIR/r2c-slack-notify.sh"
SLACK_MSG="🔓 *R2C 24h 自走モード OFF* — 解除時刻 \`$NOW_ISO\` (repo: $GH_REPO)"
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

# ─── 5. Cloudflare Pages 再開手順 ───
cat <<'CF'

────────────────────────────────────────────────────────
ℹ️  手動操作: Cloudflare Pages auto-deploy 再開
────────────────────────────────────────────────────────
  1. https://dash.cloudflare.com にログイン
  2. Workers & Pages → admin-r2c → Settings → Builds & deployments
  3. "Production branch" の "Pause deployments" を OFF
────────────────────────────────────────────────────────
CF

log "Done. 24h-mode is OFF."
