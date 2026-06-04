#!/usr/bin/env bash
# 24h-mode-off.sh — 24h 自走モード OFF
#
# Phase70-A: 24h 自走の安全装置 (論理層) — on.sh の autonomy 部分のみを解除
#
# 機能:
#   1. main branch protection を「安全ベースライン」へ更新
#      (force/main直push/削除禁止 は ON/OFF 通じて永続)
#   2. repository allow_auto_merge を元の値に復帰
#   3. ~/.r2c-24h-mode を削除
#   4. Slack #r2c にモード OFF 通知
#   5. Cloudflare Pages の再開手順を出力
#
# 設計方針:
#   旧版は backup から pre-on 状態を復元していたが、pre-on が無保護だと OFF 中に
#   main が無防備 (force push / 直push 可) になり「main直push禁止・force禁止」
#   invariant が ON/OFF 切替で消える問題があった。
#   このため OFF でも force/直push/削除禁止は維持し、autonomy 特有の縛り
#   (Security Scan 必須・conversation_resolution・auto-merge OFF) のみを解く。
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
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 1; }

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -f "$MODE_FILE" ]]; then
    log "WARN: $MODE_FILE not found (mode may already be OFF). Continuing cleanup…"
else
    log "Found mode file: $MODE_FILE"
fi

# ─── 0. バックアップから allow_auto_merge の元の値を先読み (backup 削除前に必要) ───
ORIG_AUTO_MERGE="true"  # fallback: 元の値が不明な場合は true (最もよくある設定)
if [[ "$DRY_RUN" -eq 0 ]] && [[ -f "$BACKUP_FILE" ]]; then
    ORIG_AUTO_MERGE=$(jq -r '.original_allow_auto_merge // true' "$BACKUP_FILE" 2>/dev/null || echo "true")
fi

# ─── 1. branch protection を「安全ベースライン」へ更新 ───
# ベースライン (ON/OFF 通じて永続): force禁止 / 削除禁止 / PR必須(direct push禁止) /
#   enforce_admins:false / approval:0 / required_status_checks:null
# (旧版は backup から pre-on を復元していたが、pre-on が無保護だと OFF 中に
#  main が無防備になるため、ベースラインを必ず適用する設計に変更)
log "Applying safety baseline branch protection on $GH_REPO main…"

BASELINE_PAYLOAD=$(jq -nc '{
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 0
    },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: false
}')

if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] gh api -X PUT repos/%s/branches/main/protection --input <baseline>\n' "$GH_REPO"
    echo '[dry-run] payload:'
    printf '%s' "$BASELINE_PAYLOAD" | jq .
else
    if printf '%s' "$BASELINE_PAYLOAD" | gh api -X PUT "repos/$GH_REPO/branches/main/protection" --input - >/tmp/24h-mode-off-protection.json 2>&1; then
        log "  ✓ safety baseline applied (force/main直push/削除禁止 持続, 人間 merge 可)"
    else
        echo "ERROR: Failed to apply safety baseline protection." >&2
        cat /tmp/24h-mode-off-protection.json >&2
        echo "  Backup preserved at: $BACKUP_FILE" >&2
        echo "  Manual restore via: https://github.com/$GH_REPO/settings/branches" >&2
        exit 1
    fi
fi

# ─── 2. allow_auto_merge を元の値に復帰 ───
# 注: backup 削除は PATCH 成功後まで遅延 (失敗時に元の値で再試行できるよう保持)。
log "Restoring repository auto-merge to original value (${ORIG_AUTO_MERGE})…"
run "gh api -X PATCH 'repos/$GH_REPO' -f allow_auto_merge=${ORIG_AUTO_MERGE} >/dev/null"
log "  ✓ allow_auto_merge=${ORIG_AUTO_MERGE}"

# ─── 2.5. backup file 削除 (PATCH 成功後、復元不可能性を回避) ───
if [[ "$DRY_RUN" -eq 0 ]] && [[ -f "$BACKUP_FILE" ]]; then
    rm -f "$BACKUP_FILE"
    log "  ✓ backup file removed (mode fully reverted)"
fi

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
