#!/usr/bin/env bash
# ci-failure-watcher.sh — GitHub Actions 失敗を検知して 24h キューに自動修正タスクを投入
#
# 動作:
#   1. `gh run list --branch main` で直近10件を取得
#   2. conclusion=failure のうち未処理のものを抽出
#   3. 失敗ログを gh run view --log-failed で取得
#   4. r2c-queue-add.sh で tasks テーブルに INSERT
#   5. 処理済み run_id を HANDLED_FILE に記録（重複投入防止）
#
# 起動: launchd com.r2c.ci-watcher (StartInterval=300)
#   手動: bash SCRIPTS/ci-failure-watcher.sh [--dry-run]
#
# 必要環境:
#   gh CLI (認証済み)
#   sqlite3 (queue DB 存在時のみ投入)

set -euo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${R2C_ROOT}/.claude/queue/r2c-queue.db"
HANDLED_FILE="${R2C_CONFIG}/logs/ci-watcher-handled.txt"
LOG_FILE="${R2C_CONFIG}/logs/ci-failure-watcher.log"
GH_REPO="milechy/commerce-faq-tasks"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

mkdir -p "$(dirname "$HANDLED_FILE")"
touch "$HANDLED_FILE"

log() {
    local msg="[$(date '+%Y-%m-%dT%H:%M:%S')] $*"
    echo "$msg"
    if [ "$DRY_RUN" -eq 0 ]; then
        echo "$msg" >> "$LOG_FILE"
    fi
}

log "=== ci-failure-watcher start (dry=${DRY_RUN}) ==="

# gh CLI 確認
if ! command -v gh &>/dev/null; then
    log "ERROR: gh CLI not found — skip"
    exit 0
fi

# キュー DB 存在確認（24h ループが OFF の場合は投入しない）
if [ ! -f "$QUEUE_DB" ] && [ "$DRY_RUN" -eq 0 ]; then
    log "INFO: queue DB not found ($QUEUE_DB) — 24h loop未起動のためスキップ"
    exit 0
fi

# GitHub Actions の直近 main push ランを取得
RUNS_JSON=$(gh run list \
    --repo "$GH_REPO" \
    --branch main \
    --event push \
    --limit 10 \
    --json databaseId,conclusion,headSha,displayTitle,workflowName,createdAt,url \
    2>/dev/null || echo "[]")

if [ "$RUNS_JSON" = "[]" ] || [ -z "$RUNS_JSON" ]; then
    log "INFO: no runs found"
    exit 0
fi

# 失敗ラン抽出（TAB 区切り: run_id\tsha\tworkflow\ttitle\turl）
FAILED_RUNS=$(echo "$RUNS_JSON" | python3 -c "
import json, sys
runs = json.load(sys.stdin)
for r in runs:
    if r.get('conclusion') == 'failure':
        print('\t'.join([
            str(r['databaseId']),
            r['headSha'][:7],
            r['workflowName'].replace('\t', ' '),
            r['displayTitle'][:80].replace('\t', ' '),
            r['url'],
        ]))
" 2>/dev/null || true)

if [ -z "$FAILED_RUNS" ]; then
    log "INFO: no failed runs"
    exit 0
fi

ADDED=0

while IFS=$'\t' read -r RUN_ID SHORT_SHA WORKFLOW COMMIT_MSG RUN_URL_LINE; do

    # 処理済みチェック
    if grep -qx "$RUN_ID" "$HANDLED_FILE" 2>/dev/null; then
        log "  skip: run $RUN_ID already handled"
        continue
    fi

    log "  detected failure: run=$RUN_ID sha=$SHORT_SHA workflow=$WORKFLOW"

    # 失敗ログ取得（最大150行）
    FAIL_LOG=$(gh run view "$RUN_ID" --repo "$GH_REPO" --log-failed 2>/dev/null | head -150 || echo "(ログ取得失敗)")
    RUN_URL="${RUN_URL_LINE:-https://github.com/${GH_REPO}/actions/runs/${RUN_ID}}"

    # キュー投入用 notes 生成
    NOTES="CI自動修正タスク — GitHub Actions 失敗を検知

Workflow: ${WORKFLOW}
Commit: ${SHORT_SHA}
Message: ${COMMIT_MSG}
Run URL: ${RUN_URL}

失敗ログ（抜粋）:
$(echo "$FAIL_LOG" | head -120)

対応手順:
1. 上記ログを調査して根本原因を特定
2. src/ / admin-ui/ / SCRIPTS/ を修正
3. Gate 1 (pnpm verify) を通過させる
4. feature branch で PR を作成してマージキューに入れる
5. SCRIPTS/gate-8.5-scenario-smoke.sh をローカルで動作確認"

    TASK_NAME="CI Fix [${SHORT_SHA}]: ${COMMIT_MSG}"
    SYNTHETIC_GID="ci-${RUN_ID}"

    if [ "$DRY_RUN" -eq 1 ]; then
        log "  [DRY RUN] would add task: gid=${SYNTHETIC_GID} name=${TASK_NAME}"
        log "  notes preview: $(echo "$NOTES" | head -5)..."
    else
        TASK_ID=$(bash "${R2C_ROOT}/SCRIPTS/r2c-queue-add.sh" \
            --asana-gid "$SYNTHETIC_GID" \
            --name "$TASK_NAME" \
            --tier A \
            --task-type prod_change \
            --notes "$NOTES" \
            --permalink "$RUN_URL" \
            --night-mode-allowed 0 \
            2>&1) || true

        if [ -n "$TASK_ID" ]; then
            log "  queued: task_id=${TASK_ID} gid=${SYNTHETIC_GID}"
            echo "$RUN_ID" >> "$HANDLED_FILE"
            ADDED=$((ADDED + 1))

            # Slack 通知（修正タスク投入済み）
            SECRETS_FILE="${R2C_CONFIG}/secrets/r2c-loop.env"
            if [ -f "$SECRETS_FILE" ]; then
                # shellcheck disable=SC1090
                source "$SECRETS_FILE" 2>/dev/null || true
            fi
            if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
                MSG="🔧 *CI失敗を検知 → 自動修正タスクをキュー投入*\nWorkflow: ${WORKFLOW}\nCommit: \`${SHORT_SHA}\` ${COMMIT_MSG}\nTask ID: ${TASK_ID}\n<${RUN_URL}|Actions ログ>"
                curl -s -X POST "${SLACK_WEBHOOK_URL}" \
                    -H 'Content-type: application/json' \
                    --data "{\"text\":\"${MSG}\"}" || true
            fi
        else
            log "  WARN: queue-add returned empty (duplicate or error)"
            # duplicate は正常（べき等）— handled に記録して次回スキップ
            echo "$RUN_ID" >> "$HANDLED_FILE"
        fi
    fi
done <<< "$FAILED_RUNS"

log "=== ci-failure-watcher done (added=${ADDED}) ==="
