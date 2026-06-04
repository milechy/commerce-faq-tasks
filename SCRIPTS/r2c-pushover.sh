#!/usr/bin/env bash
# r2c-pushover.sh — R2C 24h ループ用 Pushover 通知ヘルパ
#
# 用途:
#   docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md §2 の priority マッピング
#   (-2 〜 +2) を bake-in した Pushover 通知 CLI。
#   priority -1 / -2 は Pushover に送らず r2c-slack-notify.sh に委譲。
#
# 環境変数 (${R2C_CONFIG}/secrets/r2c-loop.env 経由):
#   PUSHOVER_TOKEN   — Pushover application token
#   PUSHOVER_USER    — Pushover user key
#   PUSHOVER_DEVICE  — (optional) 特定デバイス
#   SLACK_WEBHOOK_URL — (priority -1/-2 で Slack 移譲時)
#
# 呼び出し例:
#   r2c-pushover.sh --priority 1 --summary "Tier S 承認待ち: 1 件" \
#       --details-url "https://app.asana.com/0/.../GID"
#   r2c-pushover.sh --priority -2 --summary "daily morning report 投稿完了"
#   r2c-pushover.sh --priority 2 --summary "本番 /health 5min 503" --task-id 42
#   r2c-pushover.sh --dry-run --priority 0 --summary "Lane 2 回目失敗"
#
# Exit code:
#   0 = success / 1 = env or arg error / 2 = anti-slop violation
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"
SLACK_NOTIFY_BIN="${R2C_ROOT}/SCRIPTS/r2c-slack-notify.sh"
PUSHOVER_API="https://api.pushover.net/1/messages.json"

PRIORITY=""
SUMMARY=""
DETAILS_URL=""
TASK_ID=""
DRY_RUN=0

usage() {
    cat <<'USAGE'
Usage: r2c-pushover.sh --priority <-2..2> --summary <text> \
                       [--details-url <url>] [--task-id <queue-id>] [--dry-run]
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --priority)    PRIORITY="${2:-}"; shift 2 ;;
        --summary)     SUMMARY="${2:-}"; shift 2 ;;
        --details-url) DETAILS_URL="${2:-}"; shift 2 ;;
        --task-id)     TASK_ID="${2:-}"; shift 2 ;;
        --dry-run)     DRY_RUN=1; shift ;;
        -h|--help)     usage; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

if [[ -z "$PRIORITY" || -z "$SUMMARY" ]]; then
    echo "ERROR: --priority and --summary are required" >&2
    usage
    exit 1
fi

case "$PRIORITY" in
    -2|-1|0|1|2) : ;;
    *) echo "ERROR: --priority must be one of -2,-1,0,1,2 (got: $PRIORITY)" >&2; exit 1 ;;
esac

mkdir -p "$LOG_DIR"

# secrets env 読み込み (未設定でも続行、必要時に再チェック)
# shellcheck disable=SC1091
[[ -f "${R2C_CONFIG}/secrets/r2c-loop.env" ]] \
    && source "${R2C_CONFIG}/secrets/r2c-loop.env"

# log redirect (dry-run は stdout を残す)
if [[ "$DRY_RUN" -eq 0 ]]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*"; }

# ─── Anti-slop guard (SPEC §3.1 / CLAUDE.md) ───
# summary + details-url を結合して PII/API キー/tenantId UUID を検知
SCAN_TEXT="${SUMMARY} ${DETAILS_URL}"
if printf '%s' "$SCAN_TEXT" | grep -qE \
    -e 'tenantId[[:space:]]*[=:][[:space:]]*[A-Za-z0-9-]{8,}' \
    -e 'api[_-]?key[[:space:]]*[=:][[:space:]]*[A-Za-z0-9_-]{8,}' \
    -e 'Bearer[[:space:]]+[A-Za-z0-9._-]+' \
    -e '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    -e 'sk-[A-Za-z0-9]{16,}' ; then
    log "ERROR: anti-slop violation (PII/api_key/tenantId detected in summary/details-url) — BLOCKED"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "ERROR: anti-slop violation — BLOCKED" >&2
    fi
    exit 2
fi

# summary 30 文字目安 (超過は切詰)
SUMMARY_BYTES=$(printf '%s' "$SUMMARY" | wc -c | tr -d ' ')
if [[ "$SUMMARY_BYTES" -gt 90 ]]; then
    # 日本語 UTF-8 約3byte/字。90byte 目安 = 約 30 字。
    log "WARN: summary too long (${SUMMARY_BYTES} bytes) — truncating"
    SUMMARY="$(printf '%s' "$SUMMARY" | cut -c1-30)"
fi

# ─── priority -1 / -2 は Slack のみ ───
if [[ "$PRIORITY" == "-1" || "$PRIORITY" == "-2" ]]; then
    log "priority=$PRIORITY → delegating to r2c-slack-notify.sh (Pushover suppressed)"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "[dry-run] would call: $SLACK_NOTIFY_BIN --text \"[P${PRIORITY}] ${SUMMARY}${DETAILS_URL:+ — ${DETAILS_URL}}\""
        exit 0
    fi
    if [[ ! -x "$SLACK_NOTIFY_BIN" ]]; then
        log "ERROR: $SLACK_NOTIFY_BIN not executable"
        exit 1
    fi
    "$SLACK_NOTIFY_BIN" --text "[P${PRIORITY}] ${SUMMARY}${DETAILS_URL:+ — ${DETAILS_URL}}" \
        --dry-run=false 2>&1 || log "WARN: slack delegation failed"
    exit 0
fi

# ─── Pushover credentials check (skip for dry-run; placeholder shown) ───
if [[ "$DRY_RUN" -eq 0 ]]; then
    if [[ -z "${PUSHOVER_TOKEN:-}" || -z "${PUSHOVER_USER:-}" ]]; then
        log "ERROR: PUSHOVER_TOKEN / PUSHOVER_USER not set (check ${R2C_CONFIG}/secrets/r2c-loop.env)"
        exit 1
    fi
fi
PUSHOVER_TOKEN="${PUSHOVER_TOKEN:-DRY_RUN_TOKEN}"
PUSHOVER_USER="${PUSHOVER_USER:-DRY_RUN_USER}"

# ─── Pushover payload build ───
TITLE="R2C ${SUMMARY}"
build_curl_args() {
    local -a args=()
    args+=(--form-string "token=${PUSHOVER_TOKEN}")
    args+=(--form-string "user=${PUSHOVER_USER}")
    args+=(--form-string "title=${TITLE}")
    args+=(--form-string "message=${SUMMARY}${TASK_ID:+ (task=${TASK_ID})}")
    args+=(--form-string "priority=${PRIORITY}")
    if [[ -n "${PUSHOVER_DEVICE:-}" ]]; then
        args+=(--form-string "device=${PUSHOVER_DEVICE}")
    fi
    if [[ -n "$DETAILS_URL" ]]; then
        args+=(--form-string "url=${DETAILS_URL}")
    fi
    # priority 2 = Emergency: SPEC §2.1 retry=60 / expire=3600 bake-in
    if [[ "$PRIORITY" == "2" ]]; then
        args+=(--form-string "retry=60")
        args+=(--form-string "expire=3600")
        args+=(--form-string "sound=siren")
    fi
    printf '%s\n' "${args[@]}"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] Pushover payload:"
    build_curl_args | sed 's/^/  /'
    exit 0
fi

# ─── Send (no retry; caller decides) ───
mapfile -t CURL_ARGS < <(build_curl_args)
RESPONSE="$(curl -sS --max-time 30 "${CURL_ARGS[@]}" "$PUSHOVER_API" 2>&1 || true)"

if printf '%s' "$RESPONSE" | grep -q '"status":1'; then
    log "Pushover sent (priority=${PRIORITY} task_id=${TASK_ID:-none}): ${SUMMARY}"
    exit 0
else
    log "ERROR: Pushover send failed: ${RESPONSE}"
    exit 1
fi
