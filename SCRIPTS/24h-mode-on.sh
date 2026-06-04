#!/usr/bin/env bash
# 24h-mode-on.sh — 24h 自走モード ON
#
# Phase70-A: 24h 自走の安全装置 (論理層)
#
# 機能:
#   1. main branch protection を有効化 (PR必須=direct push禁止 / force・削除禁止 /
#      admin は手動merge可 [enforce_admins=false] / approval 0 / Security Scan 非必須)
#   2. repository allow_auto_merge OFF
#   3. 既存 open PR の auto-merge フラグ解除
#   4. ~/.r2c-24h-mode に R2C_24H_MODE=1 + 起動時刻を書く
#   5. Slack #r2c にモード ON 通知
#   6. Cloudflare Pages の手動停止手順を出力 (自動化はしない)
#
# 設計方針 (Phase70 安全弁の本質):
#   Lane の main 到達阻止は (a) settings.json deny 層 [git push origin main /
#   force / gh pr merge] と (b) branch protection の force/main直push/削除禁止 +
#   PR必須 + auto-merge OFF の二重で担保。
#   一方で 1人開発では approval 必須 + enforce_admins=true は人間 merge を阻害
#   して詰むため、approval=0 / enforce_admins=false に。Security Scan は既存依存
#   20件で常時 FAIL のため required から外し、人間が朝レビューで内訳判断する
#   (UATa/DIA1000 と同方針)。
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
#   STATUS_CHECKS        — required status checks (CSV, default: "Stream Path Check")
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
STATUS_CHECKS="${STATUS_CHECKS:-Stream Path Check}"
MODE_FILE="${R2C_24H_MODE_FILE:-$HOME/.r2c-24h-mode}"
BACKUP_FILE="${HOME}/.r2c-24h-mode-protection-backup.json"
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

# ─── 0. 現在の branch protection をバックアップ (解除時に元設定を復元するため) ───
# 再実行安全性: バックアップが既に存在する場合は上書きしない。
# 初回実行途中で失敗して再実行した場合に、既に変更済みの設定を元の設定と
# 誤認識してしまう問題を防ぐ。
log "Backing up current branch protection to ${BACKUP_FILE}..."
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] gh api repos/%s/branches/main/protection → %s\n' "$GH_REPO" "$BACKUP_FILE"
    printf '[dry-run] gh api repos/%s --jq .allow_auto_merge → %s (original_allow_auto_merge)\n' "$GH_REPO" "$BACKUP_FILE"
else
    if [[ -f "$BACKUP_FILE" ]]; then
        log "  ✓ backup already exists — preserving original (re-run of failed activation detected)"
    else
        if gh api "repos/$GH_REPO/branches/main/protection" > "$BACKUP_FILE" 2>/dev/null; then
            chmod 600 "$BACKUP_FILE"
            log "  ✓ existing protection backed up"
        else
            printf '{"no_protection":true}\n' > "$BACKUP_FILE"
            chmod 600 "$BACKUP_FILE"
            log "  ✓ no existing protection — sentinel saved"
        fi
        # allow_auto_merge の元の値をバックアップに追記 (off.sh で正確に復元するため)
        ORIG_AUTO_MERGE=$(gh api "repos/$GH_REPO" --jq '.allow_auto_merge // false' 2>/dev/null || echo "false")
        _tmp=$(mktemp)
        if jq --argjson val "$ORIG_AUTO_MERGE" '. + {original_allow_auto_merge: $val}' "$BACKUP_FILE" > "$_tmp"; then
            mv "$_tmp" "$BACKUP_FILE"
            chmod 600 "$BACKUP_FILE"
            log "  ✓ original allow_auto_merge=$ORIG_AUTO_MERGE saved to backup"
        else
            rm -f "$_tmp"
            log "  WARN: failed to save allow_auto_merge to backup (will default to true on restore)"
        fi
    fi
fi

# ─── 1. main branch protection ON ───
# 設計の核 (Phase70 安全弁): Lane 阻止は settings.json deny 層が主役。
# branch protection は (a) PR必須=direct push禁止 (b) force/削除禁止 を担保し、
# 人間 admin が手動merge できる状態 (approval=0, enforce_admins=false) を保つ。
log "Enabling branch protection on $GH_REPO main…"

CHECKS_JSON=$(printf '%s' "$STATUS_CHECKS" | jq -Rcs 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map({context: ., app_id: -1})')

PROTECTION_PAYLOAD=$(jq -nc \
    --argjson checks "$CHECKS_JSON" \
    '{
        required_status_checks: { strict: true, checks: $checks },
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
