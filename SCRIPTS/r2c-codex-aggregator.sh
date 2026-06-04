#!/usr/bin/env bash
# r2c-codex-aggregator.sh — R2C 24h ループ Codex Gate 2.5 集計
#
# 用途:
#   queue (.claude/queue/r2c-queue.db) から state='pr_created' の全タスクを抽出し、
#   `gh pr view` で merged 状態を確認 (reconcile)。既に merged なら state を `merged`
#   に更新する。gate_2_5_required≠1 の CLI 直接 PR も対象 (GID 1215263653870104)。
#   未 merge かつ gate_2_5_required=1 の OPEN PR のみ朝の Codex review 待ち件数として
#   集計する (gate_2_5_required≠1 の OPEN PR は人間マージ待ちで Codex 対象外)。
#   morning-report.sh から --output-block で呼び出され、Slack Block Kit の
#   1 セクションとして結果を返す。
#
# 環境変数:
#   QUEUE_DB         — 既定 ${R2C_ROOT}/.claude/queue/r2c-queue.db
#   GITHUB_REPO_SLUG — 既定 milechy/commerce-faq-tasks
#
# 呼び出し例:
#   r2c-codex-aggregator.sh --output-block     # Block Kit 部分 JSON を stdout
#   r2c-codex-aggregator.sh --dry-run          # 集計のみ表示
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"
REPO_SLUG="${GITHUB_REPO_SLUG:-milechy/commerce-faq-tasks}"

OUTPUT_BLOCK=0
DRY_RUN=0

usage() {
    cat <<'USAGE'
Usage: r2c-codex-aggregator.sh [--output-block] [--dry-run]
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --output-block) OUTPUT_BLOCK=1; shift ;;
        --dry-run)      DRY_RUN=1; shift ;;
        -h|--help)      usage; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

mkdir -p "$LOG_DIR"

if [[ "$DRY_RUN" -eq 0 && "$OUTPUT_BLOCK" -eq 0 ]]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >&2; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 1; }

# ─── Collect rows from queue (graceful when DB absent) ───
pending_rows=""
if command -v sqlite3 >/dev/null 2>&1 && [[ -r "$QUEUE_DB" ]]; then
    # reconcile(merge同期)は全 pr_created を対象にする。gate_2_5_required で絞ると
    # CLI 直接 PR 化タスク(gate_2_5_required≠1)が merged 後も pr_created に永久残留する
    # (GID 1215263653870104)。merge 同期と Gate2.5 レビュー集約は別関心事なので分離し、
    # gate_2_5_required は列として取得して下流の「Codex 待ち」集計だけに使う。
    pending_rows="$(sqlite3 -separator '|' "$QUEUE_DB" \
        "SELECT id, asana_gid, asana_name, pr_number, pr_url, COALESCE(gate_2_5_required, 0) \
         FROM tasks \
         WHERE state = 'pr_created' \
         ORDER BY pr_number ASC;" 2>/dev/null || true)"
else
    log "WARN: queue DB not found or sqlite3 missing (db=${QUEUE_DB}) — empty result"
fi

waiting_count=0
merged_count=0
waiting_lines=()

if [[ -n "$pending_rows" ]]; then
    while IFS='|' read -r task_id _asana_gid asana_name pr_number pr_url gate_2_5_required; do
        [[ -z "${pr_number:-}" ]] && continue
        pr_state="UNKNOWN"
        merged_at="null"
        if command -v gh >/dev/null 2>&1; then
            pr_json="$(gh pr view "$pr_number" --repo "$REPO_SLUG" \
                --json mergedAt,state 2>/dev/null || echo '{}')"
            pr_state="$(printf '%s' "$pr_json" | jq -r '.state // "UNKNOWN"')"
            merged_at="$(printf '%s' "$pr_json" | jq -r '.mergedAt // "null"')"
        else
            log "WARN: gh CLI missing — cannot resolve PR #${pr_number}"
        fi

        if [[ "$merged_at" != "null" && -n "$merged_at" ]]; then
            merged_count=$((merged_count + 1))
            if [[ "$DRY_RUN" -eq 0 && -w "$QUEUE_DB" ]]; then
                sqlite3 "$QUEUE_DB" \
                    "UPDATE tasks SET state='merged', updated_at=datetime('now') WHERE id=${task_id};" \
                    2>/dev/null || log "WARN: failed to update task ${task_id} → merged"
            fi
            log "merged: PR #${pr_number} (task=${task_id})"
        elif [[ "$pr_state" == "OPEN" ]]; then
            # 「Codex Gate 2.5 待ち」は gate_2_5_required=1 の OPEN PR のみ計上する。
            # gate_2_5_required≠1 の OPEN PR は人間マージ待ちであり Codex レビュー対象ではない
            # (reconcile では拾うが Codex 待ち集計には混ぜない)。
            if [[ "${gate_2_5_required:-0}" == "1" ]]; then
                waiting_count=$((waiting_count + 1))
                short_name="$(printf '%s' "$asana_name" | cut -c1-40)"
                url="${pr_url:-https://github.com/${REPO_SLUG}/pull/${pr_number}}"
                waiting_lines+=("• <${url}|PR #${pr_number}> ${short_name}")
            else
                log "open (awaiting merge, non-gate): PR #${pr_number} (task=${task_id})"
            fi
        else
            log "skip: PR #${pr_number} state=${pr_state} (neither merged nor open)"
        fi
    done <<< "$pending_rows"
fi

# ─── Render summary ───
summary_text="*🤖 Codex Gate 2.5 待ち*: ${waiting_count} 件 (本実行で merged 検出: ${merged_count})"
detail_text="(該当 PR なし)"
if [[ "${#waiting_lines[@]}" -gt 0 ]]; then
    detail_text="$(printf '%s\n' "${waiting_lines[@]}")"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $summary_text"
    echo "$detail_text"
    exit 0
fi

if [[ "$OUTPUT_BLOCK" -eq 1 ]]; then
    # Block Kit 部分 JSON: 2 つの section (header + 詳細)
    jq -nc \
        --arg summary "$summary_text" \
        --arg detail  "$detail_text" \
        '[
           { type: "section", text: { type: "mrkdwn", text: $summary } },
           { type: "section", text: { type: "mrkdwn", text: $detail  } }
         ]'
    exit 0
fi

log "summary: ${summary_text}"
log "detail: ${detail_text}"
exit 0
