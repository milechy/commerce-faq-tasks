#!/usr/bin/env bash
# r2c-asana-poll.sh
# 用途: Asana を 5 分間隔で polling し、新規タスクを SQLite queue に取り込む
# Cron 間隔: */5 * * * *
# 必要環境変数:
#   ASANA_ACCESS_TOKEN  (必須、${R2C_CONFIG}/secrets/r2c-loop.env から読込)
# 呼び出し例:
#   bash SCRIPTS/r2c-asana-poll.sh
#   bash SCRIPTS/r2c-asana-poll.sh --dry-run
#
# Phase 1 Step E-A (Asana 統合 4 本のうち 1) — 詳細は
# docs/24H_AUTOMATION_RUNBOOK_R2C.md を参照。

set -euo pipefail

# ─── R2C 定数 (bake-in) ────────────────────────────────────────────────────
ASANA_PROJECT_GID="1213607637045514"
R2C_ROOT="${R2C_ROOT:-$HOME/Documents/GitHub/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${R2C_ROOT}/.claude/queue/r2c-queue.db"
LOG_DIR="${R2C_CONFIG}/logs"
SCRIPT_NAME="$(basename "$0" .sh)"

# ─── 引数 ──────────────────────────────────────────────────────────────────
DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
    esac
done

mkdir -p "$LOG_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

# ─── 環境変数読込 ─────────────────────────────────────────────────────────
# shellcheck disable=SC1091
source "${R2C_CONFIG}/secrets/r2c-loop.env" 2>/dev/null || true

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-asana-poll start (dry-run=${DRY_RUN}) ==="

if [ -z "${ASANA_ACCESS_TOKEN:-}" ]; then
    echo "ERROR: ASANA_ACCESS_TOKEN not set. Place 'export ASANA_ACCESS_TOKEN=...' in ${R2C_CONFIG}/secrets/r2c-loop.env" >&2
    exit 1
fi

if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$QUEUE_DB" ]; then
    echo "ERROR: Queue DB not found: $QUEUE_DB" >&2
    exit 1
fi

# ─── ヘルパー ─────────────────────────────────────────────────────────────
SQ() { sqlite3 "$QUEUE_DB" "$1"; }
sqlq() { local s=${1//\'/\'\'}; printf "'%s'" "$s"; }

# ─── Asana API ─────────────────────────────────────────────────────────────
RAW=$(mktemp)
TASKS_JSON=$(mktemp)
trap 'rm -f "$RAW" "$TASKS_JSON"' EXIT

ASANA_URL="https://app.asana.com/api/1.0/tasks?project=${ASANA_PROJECT_GID}&completed_since=now&opt_fields=name,notes,due_on,permalink_url,completed&limit=100"

if ! curl -sf --max-time 20 \
    -H "Authorization: Bearer ${ASANA_ACCESS_TOKEN}" \
    -H "Accept: application/json" \
    "$ASANA_URL" > "$RAW"; then
    echo "WARNING: Asana API call failed, skipping this cycle"
    exit 0
fi

if ! jq -e '.data' < "$RAW" >/dev/null 2>&1; then
    echo "WARNING: Unexpected Asana response (first 500 bytes):"
    head -c 500 "$RAW"; echo ""
    exit 0
fi

jq '[.data[] | select(.completed == false) | {
      gid,
      name,
      notes: (.notes // ""),
      due_on: (.due_on // ""),
      permalink_url: (.permalink_url // "")
    }]' < "$RAW" > "$TASKS_JSON"

TASK_COUNT=$(jq 'length' < "$TASKS_JSON")
echo "Found ${TASK_COUNT} open Asana tasks"

if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: would process ${TASK_COUNT} tasks. Sample:"
    jq -r '.[0:3] | .[] | "  - " + .gid + " | " + .name' < "$TASKS_JSON" || true
    echo "DRY-RUN: queue writes skipped"
    exit 0
fi

# ─── Queue 取り込み ───────────────────────────────────────────────────────
NEW_COUNT=0
UPDATED_COUNT=0

while IFS= read -r task_json; do
    GID=$(jq -r '.gid' <<< "$task_json")
    NAME=$(jq -r '.name' <<< "$task_json")
    NOTES=$(jq -r '.notes' <<< "$task_json")
    DUE_ON=$(jq -r '.due_on' <<< "$task_json")
    PERMALINK=$(jq -r '.permalink_url' <<< "$task_json")

    # Tier prefix 抽出: タスク名先頭の [Tier B|A|S] を正規表現で
    TIER="B"
    if [[ "$NAME" =~ \[Tier\ ?S\] ]]; then
        TIER="S"
    elif [[ "$NAME" =~ \[Tier\ ?A\] ]]; then
        TIER="A"
    elif [[ "$NAME" =~ \[Tier\ ?B\] ]]; then
        TIER="B"
    fi

    # task_type: <種類>: 部分を抽出
    TASK_TYPE="other"
    if [[ "$NAME" =~ (skill|hook|docs|schema|api|migration|test|prod_change): ]]; then
        TASK_TYPE="${BASH_REMATCH[1]}"
    fi

    # Tier S は夜間禁止、Tier A も夜間禁止 (UATa 慣習踏襲)
    NIGHT_OK=1
    if [ "$TIER" = "S" ] || [ "$TIER" = "A" ]; then
        NIGHT_OK=0
    fi

    EXISTS=$(SQ "SELECT COUNT(*) FROM tasks WHERE asana_gid = '${GID}';")

    if [ "$EXISTS" = "0" ]; then
        if ! bash "${R2C_ROOT}/SCRIPTS/r2c-queue-add.sh" \
                --asana-gid "$GID" \
                --name "$NAME" \
                --tier "$TIER" \
                --task-type "$TASK_TYPE" \
                --notes "$NOTES" \
                --permalink "$PERMALINK" \
                --due-on "$DUE_ON" \
                --night-mode-allowed "$NIGHT_OK" 2>&1; then
            echo "WARNING: r2c-queue-add.sh failed for GID ${GID}"
            continue
        fi
        NEW_COUNT=$((NEW_COUNT + 1))
        echo "  + NEW: [Tier ${TIER}/${TASK_TYPE}] ${NAME} (GID ${GID})"
    else
        OLD_NAME=$(SQ "SELECT asana_name FROM tasks WHERE asana_gid = '${GID}';")
        if [ "$OLD_NAME" != "$NAME" ]; then
            SQ "UPDATE tasks SET asana_name = $(sqlq "$NAME") WHERE asana_gid = '${GID}';"
            UPDATED_COUNT=$((UPDATED_COUNT + 1))
        fi
    fi
done < <(jq -c '.[]' < "$TASKS_JSON")

SQ "INSERT OR REPLACE INTO automation_state (key, value) VALUES ('last_asana_poll', '$(date -u +%Y-%m-%dT%H:%M:%SZ)');" || true

echo "Summary: ${NEW_COUNT} new, ${UPDATED_COUNT} updated"
echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-asana-poll done ==="
echo ""
