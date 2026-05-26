#!/usr/bin/env bash
# r2c-generate-lane.sh
# 用途: queue の task ID を受け取り、lane-templates から適切なテンプレを
#       選択 → プレースホルダ置換 → .claude/lanes/lane-<id>.md に出力。
#       changedFiles 判別ロジックは未実装 (本スクリプトは prompt 生成のみ)。
# 呼び出し例:
#   bash SCRIPTS/r2c-generate-lane.sh --task-id 42
#   bash SCRIPTS/r2c-generate-lane.sh --task-id 42 --dry-run
#
# Phase 1 Step E-A — docs/24H_AUTOMATION_RUNBOOK_R2C.md 参照。

set -euo pipefail

# ─── R2C 定数 ─────────────────────────────────────────────────────────────
R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${R2C_ROOT}/.claude/queue/r2c-queue.db"
TEMPLATE_DIR="${R2C_ROOT}/.claude/lane-templates"
LANES_DIR="${R2C_ROOT}/.claude/lanes"
WORKTREE_BASE="${R2C_ROOT}/.claude/worktrees"
LOG_DIR="${R2C_CONFIG}/logs"
SCRIPT_NAME="$(basename "$0" .sh)"

# ─── 引数 ──────────────────────────────────────────────────────────────────
TASK_ID=""
DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --task-id) TASK_ID="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [ -z "$TASK_ID" ]; then
    echo "Usage: $0 --task-id <id> [--dry-run]" >&2
    exit 1
fi

mkdir -p "$LOG_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

# shellcheck disable=SC1091
source "${R2C_CONFIG}/secrets/r2c-loop.env" 2>/dev/null || true

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-generate-lane start (task=${TASK_ID} dry=${DRY_RUN}) ==="

if [ ! -f "$QUEUE_DB" ]; then
    echo "ERROR: Queue DB not found: $QUEUE_DB" >&2
    exit 1
fi
if [ ! -d "$TEMPLATE_DIR" ]; then
    echo "ERROR: Template dir not found: $TEMPLATE_DIR" >&2
    exit 1
fi

# ─── ヘルパー ─────────────────────────────────────────────────────────────
SQ() { sqlite3 "$QUEUE_DB" "$1"; }
sqlq() { local s=${1//\'/\'\'}; printf "'%s'" "$s"; }

TASK_DATA=$(SQ "SELECT asana_gid, asana_name, asana_notes, asana_permalink, asana_due_on, tier, task_type, model FROM tasks WHERE id = ${TASK_ID};")
if [ -z "$TASK_DATA" ]; then
    echo "ERROR: Task ${TASK_ID} not found" >&2
    exit 1
fi

IFS='|' read -r ASANA_GID ASANA_NAME ASANA_NOTES ASANA_PERMALINK ASANA_DUE_ON TIER TASK_TYPE MODEL <<< "$TASK_DATA"

# ─── テンプレ選択 ────────────────────────────────────────────────────────
TEMPLATE_FILE=""
case "${TIER}:${TASK_TYPE}" in
    "B:docs"|"B:test"|"B:other") TEMPLATE_FILE="${TEMPLATE_DIR}/tier-b-docs.md" ;;
    "B:skill"|"B:hook")          TEMPLATE_FILE="${TEMPLATE_DIR}/tier-b-skill.md" ;;
    "A:api"|"A:migration")       TEMPLATE_FILE="${TEMPLATE_DIR}/tier-a-api.md" ;;
    "A:schema")                  TEMPLATE_FILE="${TEMPLATE_DIR}/tier-a-schema.md" ;;
    "S:"*)                       TEMPLATE_FILE="${TEMPLATE_DIR}/tier-s-prod.md" ;;
    *)
        echo "WARNING: no template match for tier=${TIER} type=${TASK_TYPE}, fallback to tier-b-docs.md"
        TEMPLATE_FILE="${TEMPLATE_DIR}/tier-b-docs.md"
        ;;
esac

if [ ! -f "$TEMPLATE_FILE" ]; then
    echo "ERROR: Template missing: ${TEMPLATE_FILE}" >&2
    exit 1
fi

# ─── branch / worktree path 算出 ─────────────────────────────────────────
SAFE_NAME=$(echo "$ASANA_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
[ -z "$SAFE_NAME" ] && SAFE_NAME="task"
BRANCH_NAME="auto/${TIER,,}-${TASK_ID}-${SAFE_NAME}"
WORKTREE_PATH="${WORKTREE_BASE}/lane-${TASK_ID}-${SAFE_NAME}"
OUTPUT="${LANES_DIR}/lane-${TASK_ID}.md"

echo "Template: ${TEMPLATE_FILE}"
echo "Branch:   ${BRANCH_NAME}"
echo "Worktree: ${WORKTREE_PATH}"
echo "Output:   ${OUTPUT}"

# ─── プレースホルダ置換 ──────────────────────────────────────────────────
# 単純な値 (GID / branch / worktree / id / tier / type / model / due / permalink)
# は sed で置換。Asana name/notes は改行・特殊文字を含むので、テンプレ展開後の
# 末尾に専用ブロックでそのまま追記する (sed の delimiter 衝突回避)。
RENDERED=$(mktemp)
trap 'rm -f "$RENDERED"' EXIT

{
    sed -e "s|{{ASANA_GID}}|${ASANA_GID}|g" \
        -e "s|{{BRANCH_NAME}}|${BRANCH_NAME}|g" \
        -e "s|{{WORKTREE_PATH}}|${WORKTREE_PATH}|g" \
        -e "s|{{TASK_ID}}|${TASK_ID}|g" \
        -e "s|{{TIER}}|${TIER}|g" \
        -e "s|{{TASK_TYPE}}|${TASK_TYPE}|g" \
        -e "s|{{MODEL}}|${MODEL:-claude-sonnet-4-6}|g" \
        -e "s|{{DUE_ON}}|${ASANA_DUE_ON}|g" \
        -e "s|{{PERMALINK}}|${ASANA_PERMALINK}|g" \
        "$TEMPLATE_FILE"
    echo ""
    echo "---"
    echo "## このタスクの内容 (Asana より自動取得)"
    echo ""
    echo "### Asana GID"
    echo "${ASANA_GID}"
    echo ""
    echo "### タスク名"
    echo "${ASANA_NAME}"
    echo ""
    echo "### Asana notes (DoD など)"
    echo "${ASANA_NOTES}"
    echo ""
    echo "### Permalink"
    echo "${ASANA_PERMALINK}"
    echo ""
    echo "### Due"
    echo "${ASANA_DUE_ON}"
} > "$RENDERED"

if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: rendered prompt follows (no file write, no DB update)"
    echo "---8<---"
    cat "$RENDERED"
    echo "--->8---"
    exit 0
fi

mkdir -p "$LANES_DIR"
mv "$RENDERED" "$OUTPUT"
trap - EXIT

SQ "UPDATE tasks SET state='prompt_generated', branch=$(sqlq "$BRANCH_NAME"), prompt_path=$(sqlq "$OUTPUT"), last_action='prompt_generated' WHERE id = ${TASK_ID};"

echo "Lane prompt generated: ${OUTPUT}"
echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-generate-lane done ==="
echo ""
