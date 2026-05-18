#!/usr/bin/env bash
# r2c-slack-notify.sh — R2C 24h ループ用 Slack 投稿ヘルパ
#
# 用途:
#   Block Kit JSON ファイルまたはプレーンテキストを R2C `#r2c` チャンネルへ送る。
#   SLACK_WEBHOOK_URL を最優先、なければ SLACK_BOT_TOKEN を使う。
#
# 環境変数 (${R2C_CONFIG}/secrets/r2c-loop.env 経由):
#   SLACK_WEBHOOK_URL  — Incoming Webhook URL（最優先）
#   SLACK_BOT_TOKEN    — Bot OAuth token (xoxb-...)
#
# 呼び出し例:
#   r2c-slack-notify.sh --block-kit /tmp/morning-blocks.json
#   r2c-slack-notify.sh --text "Lane 失敗: PR #123"
#   r2c-slack-notify.sh --text "ping" --channel C0AG07HFJTB
#   r2c-slack-notify.sh --block-kit /tmp/blocks.json --dry-run
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_ROOT="${R2C_ROOT:-$HOME/Documents/GitHub/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"
DEFAULT_CHANNEL_ID="C0AG07HFJTB"

BLOCK_KIT_FILE=""
TEXT=""
CHANNEL="$DEFAULT_CHANNEL_ID"
DRY_RUN=0

usage() {
    cat <<'USAGE'
Usage: r2c-slack-notify.sh (--block-kit <file> | --text <message>) \
                           [--channel <id>] [--dry-run]
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --block-kit) BLOCK_KIT_FILE="${2:-}"; shift 2 ;;
        --text)      TEXT="${2:-}"; shift 2 ;;
        --channel)   CHANNEL="${2:-}"; shift 2 ;;
        --dry-run)   DRY_RUN=1; shift ;;
        --dry-run=*) [[ "${1#--dry-run=}" == "true" ]] && DRY_RUN=1 || DRY_RUN=0; shift ;;
        -h|--help)   usage; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

if [[ -z "$BLOCK_KIT_FILE" && -z "$TEXT" ]]; then
    echo "ERROR: --block-kit or --text required" >&2
    usage
    exit 1
fi

if [[ -n "$BLOCK_KIT_FILE" && ! -r "$BLOCK_KIT_FILE" ]]; then
    echo "ERROR: --block-kit file not readable: $BLOCK_KIT_FILE" >&2
    exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required (brew install jq)" >&2; exit 1; }

mkdir -p "$LOG_DIR"

# shellcheck disable=SC1091
[[ -f "${R2C_CONFIG}/secrets/r2c-loop.env" ]] \
    && source "${R2C_CONFIG}/secrets/r2c-loop.env"

if [[ "$DRY_RUN" -eq 0 ]]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*"; }

# ─── Payload build ───
if [[ -n "$BLOCK_KIT_FILE" ]]; then
    # Block Kit JSON: { "blocks": [...] } を期待。channel を上書き付与。
    PAYLOAD="$(jq --arg ch "$CHANNEL" '. + { channel: $ch }' "$BLOCK_KIT_FILE")"
else
    PAYLOAD="$(jq -nc \
        --arg ch "$CHANNEL" \
        --arg text "$TEXT" \
        '{ channel: $ch, text: $text, mrkdwn: true }')"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] Slack payload (channel=$CHANNEL):"
    printf '%s\n' "$PAYLOAD"
    exit 0
fi

# ─── Send (1 retry on failure) ───
send_via_webhook() {
    local url="$1" payload="$2"
    curl -sS --max-time 30 -X POST \
        -H 'Content-Type: application/json' \
        --data "$payload" "$url"
}

send_via_bot_token() {
    local token="$1" payload="$2"
    curl -sS --max-time 30 -X POST \
        -H "Authorization: Bearer ${token}" \
        -H 'Content-Type: application/json; charset=utf-8' \
        --data "$payload" \
        'https://slack.com/api/chat.postMessage'
}

attempt() {
    if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
        send_via_webhook "$SLACK_WEBHOOK_URL" "$PAYLOAD"
    elif [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
        send_via_bot_token "$SLACK_BOT_TOKEN" "$PAYLOAD"
    else
        echo "ERROR: SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN required" >&2
        return 1
    fi
}

RESPONSE=""
for try in 1 2; do
    if RESPONSE="$(attempt 2>&1)"; then
        # Webhook returns "ok"; chat.postMessage returns JSON with "ok":true
        if [[ "$RESPONSE" == "ok" ]] || printf '%s' "$RESPONSE" | grep -q '"ok":true'; then
            log "Slack sent (channel=${CHANNEL}, attempt=${try})"
            exit 0
        fi
    fi
    log "WARN: Slack send attempt ${try} failed: ${RESPONSE}"
    [[ "$try" -eq 1 ]] && sleep 5
done

log "ERROR: Slack send failed after 2 attempts: ${RESPONSE}"
exit 1
