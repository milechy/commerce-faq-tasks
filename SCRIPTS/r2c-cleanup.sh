#!/usr/bin/env bash
# r2c-cleanup.sh — 全 worktree + ローカルブランチの後始末 (R2C 24h loop)
#
# 用途:
#   - .claude/worktrees/ 配下の worktree のうち、対応ブランチが既に merged のものを削除
#   - 古い (--age 時間以上前作成) worktree のみに限定
#   - queue で state IN ('merged','done','rollbacked','cancelled') かつ worktree_path が残っているものをチェック
#
# 環境変数:
#   R2C_ROOT, R2C_CONFIG, QUEUE_DB, WORKTREE_BASE, LOG_DIR
#
# 呼び出し例:
#   bash SCRIPTS/r2c-cleanup.sh --dry-run
#   bash SCRIPTS/r2c-cleanup.sh --age 24      # 24時間以上前の merged worktree を削除
#   bash SCRIPTS/r2c-cleanup.sh --force --yes # merge 未確認でも削除 (危険、自動承認)

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/Documents/GitHub/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"
WORKTREE_BASE="${WORKTREE_BASE:-${R2C_ROOT}/.claude/worktrees}"
LOG_DIR="${LOG_DIR:-${R2C_CONFIG}/logs}"

AGE_HOURS=24
DRY_RUN=0
FORCE=0
YES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --age)     AGE_HOURS="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --force)   FORCE=1; shift ;;
        --yes)     YES=1; shift ;;
        *)         echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/cleanup.log"
if [ "${DRY_RUN}" -eq 0 ]; then
    exec >> "${LOG_FILE}" 2>&1
fi

# shellcheck disable=SC1091
source "${R2C_CONFIG}/secrets/r2c-loop.env" 2>/dev/null || true

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-cleanup start (age=${AGE_HOURS}h, force=${FORCE}, dry-run=${DRY_RUN}) ==="

cd "${R2C_ROOT}"

# 全 worktree を列挙 (path branch hash の 3 行 1 セット)
DELETED_COUNT=0
SKIPPED_COUNT=0

while IFS= read -r WT_PATH; do
    # WORKTREE_BASE 配下のみ対象 (safety: rm -rf prefix check)
    case "${WT_PATH}" in
        "${WORKTREE_BASE}"/*) ;;
        *) continue ;;
    esac

    # ベースリポ本体は対象外
    if [ "${WT_PATH}" = "${R2C_ROOT}" ]; then
        continue
    fi

    # 該当 branch
    WT_BRANCH=$(git worktree list --porcelain | awk -v p="${WT_PATH}" '$1=="worktree" && $2==p {found=1; next} found && $1=="branch" {sub(/^refs\/heads\//,"",$2); print $2; exit}')

    # 作成からの経過時間 (秒)
    if [ ! -d "${WT_PATH}" ]; then
        continue
    fi
    if [ "$(uname)" = "Darwin" ]; then
        CREATED_TS=$(stat -f %B "${WT_PATH}" 2>/dev/null || echo 0)
    else
        CREATED_TS=$(stat -c %Y "${WT_PATH}" 2>/dev/null || echo 0)
    fi
    NOW_TS=$(date +%s)
    AGE_SECS=$((NOW_TS - CREATED_TS))
    AGE_LIMIT=$((AGE_HOURS * 3600))

    if [ "${AGE_SECS}" -lt "${AGE_LIMIT}" ]; then
        echo "  SKIP (young): ${WT_PATH} (age=${AGE_SECS}s)"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
    fi

    # merge 確認 (gh pr list で該当 branch を search)
    IS_MERGED=0
    if [ -n "${WT_BRANCH:-}" ]; then
        MERGED_COUNT=$(gh pr list --state merged --search "head:${WT_BRANCH}" --json number --jq 'length' 2>/dev/null || echo 0)
        if [ "${MERGED_COUNT}" -gt 0 ]; then
            IS_MERGED=1
        fi
    fi

    if [ "${IS_MERGED}" -eq 0 ] && [ "${FORCE}" -eq 0 ]; then
        echo "  SKIP (not-merged): ${WT_PATH} (branch=${WT_BRANCH:-unknown})"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
    fi

    if [ "${FORCE}" -eq 1 ] && [ "${YES}" -eq 0 ]; then
        printf "  CONFIRM delete %s? [y/N] " "${WT_PATH}"
        read -r ANS
        [ "${ANS}" = "y" ] || { SKIPPED_COUNT=$((SKIPPED_COUNT + 1)); continue; }
    fi

    if [ "${DRY_RUN}" -eq 1 ]; then
        echo "  [dry-run] would remove worktree=${WT_PATH} branch=${WT_BRANCH:-unknown}"
    else
        git worktree remove --force "${WT_PATH}" 2>&1 || echo "  WARN: worktree remove failed for ${WT_PATH}"
        if [ -n "${WT_BRANCH:-}" ]; then
            git branch -D "${WT_BRANCH}" 2>&1 || echo "  WARN: branch -D failed for ${WT_BRANCH}"
        fi
        echo "  REMOVED: ${WT_PATH}"
    fi
    DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(git worktree list --porcelain | awk '$1=="worktree" {print $2}')

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === done (deleted=${DELETED_COUNT}, skipped=${SKIPPED_COUNT}) ==="
