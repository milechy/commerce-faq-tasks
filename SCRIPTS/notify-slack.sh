#!/usr/bin/env bash
# notify-slack.sh — CLI 自走通知ヘルパ (Phase70-L)
#
# 用途:
#   24h 自走中の CLI が Slack #r2c (C0AG07HFJTB) へ確実に通知を届ける。
#   MCP 経由 (SLACK_BOT_TOKEN) → curl webhook → stderr の 3段フォールバック。
#
# 使い方:
#   notify-slack.sh <message> [--color info|success|warning|error]
#                             [--channel <id>] [--dry-run]
#
# 環境変数 (秘匿値は ~/.claude-r2c-config/secrets/r2c-loop.env に保管):
#   SLACK_BOT_TOKEN      — Bot OAuth token xoxb-... (Slack MCP 経由の第1試行)
#   SLACK_WEBHOOK_URL_R2C — #r2c 専用 Incoming Webhook URL (第2試行 優先)
#   SLACK_WEBHOOK_URL     — 汎用 Incoming Webhook URL (第2試行 フォールバック)
#
# 通知パターン (CLI 自走プロンプト用):
#   PR 作成完了  : notify-slack.sh "✅ PR #N pushed: <title>, ready for Gate 2.5" --color success
#   Gate 失敗    : notify-slack.sh "⚠️ Gate failed at <step>: <error>" --color warning
#   Stop 発火    : notify-slack.sh "🛑 Stopped: <reason>" --color error
#
# セキュリティ注記:
#   - Webhook URL は stderr にも stdout にも出力しない
#   - Stop signal 後の連投防止: ~/.r2c-notified-stop が存在すれば exit 0
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"
DEFAULT_CHANNEL="C0AG07HFJTB"
STOP_NOTIFIED_FILE="${R2C_CONFIG}/.r2c-notified-stop"

MESSAGE=""
COLOR="info"
CHANNEL="$DEFAULT_CHANNEL"
DRY_RUN=0

usage() {
    cat <<'USAGE'
Usage: notify-slack.sh <message> [--color info|success|warning|error]
                                 [--channel <id>] [--dry-run]
USAGE
}

# ─── 引数パース ───
while [[ $# -gt 0 ]]; do
    case "$1" in
        --color)   COLOR="${2:-info}"; shift 2 ;;
        --channel) CHANNEL="${2:-$DEFAULT_CHANNEL}"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        --*)       echo "ERROR: unknown option: $1" >&2; usage; exit 1 ;;
        *)
            if [[ -z "$MESSAGE" ]]; then
                MESSAGE="$1"
            else
                echo "ERROR: unexpected positional arg: $1" >&2
                usage; exit 1
            fi
            shift ;;
    esac
done

if [[ -z "$MESSAGE" ]]; then
    echo "ERROR: <message> required" >&2
    usage; exit 1
fi

case "$COLOR" in
    info)    HEX_COLOR="#36a64f" ;;
    success) HEX_COLOR="#2eb886" ;;
    warning) HEX_COLOR="#daa520" ;;
    error)   HEX_COLOR="#cc0000" ;;
    *)       echo "ERROR: --color must be info|success|warning|error" >&2; exit 1 ;;
esac

# ─── 環境変数ロード ───
# shellcheck disable=SC1091
[[ -f "${R2C_CONFIG}/secrets/r2c-loop.env" ]] \
    && source "${R2C_CONFIG}/secrets/r2c-loop.env"

# ─── Stop 連投防止 ───
# Stop signal 通知済みフラグがあれば重複投稿しない
if [[ "$COLOR" == "error" ]] && [[ -f "$STOP_NOTIFIED_FILE" ]]; then
    echo "[${SCRIPT_NAME}] Stop already notified, skipping duplicate." >&2
    exit 0
fi

mkdir -p "$LOG_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] [%s] %s\n' "$(ts)" "$SCRIPT_NAME" "$*"; }

# ─── Dry-run ───
if [[ "$DRY_RUN" -eq 1 ]]; then
    cat <<DRY
[dry-run] notify-slack.sh
  channel : $CHANNEL
  color   : $COLOR ($HEX_COLOR)
  message : $MESSAGE
DRY
    exit 0
fi

exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1

# ─── ペイロード構築 (Attachment 形式、color 対応) ───
build_payload_json() {
    local channel="$1" message="$2" hex_color="$3"
    printf '{"channel":"%s","attachments":[{"color":"%s","text":"%s","mrkdwn_in":["text"]}]}' \
        "$channel" "$hex_color" \
        "$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

PAYLOAD="$(build_payload_json "$CHANNEL" "$MESSAGE" "$HEX_COLOR")"

# ─── 第1試行: Slack Bot Token (MCP 経由の代替 — chat.postMessage) ───
send_via_bot_token() {
    local token="$1" payload="$2"
    local resp
    resp="$(curl -sS --max-time 15 \
        -X POST \
        -H "Authorization: Bearer ${token}" \
        -H 'Content-Type: application/json; charset=utf-8' \
        --data "$payload" \
        'https://slack.com/api/chat.postMessage' 2>&1)" || return 1
    printf '%s' "$resp" | grep -q '"ok":true' || return 1
    return 0
}

if [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
    if send_via_bot_token "$SLACK_BOT_TOKEN" "$PAYLOAD"; then
        log "Sent via bot token (attempt 1): $MESSAGE"
        [[ "$COLOR" == "error" ]] && touch "$STOP_NOTIFIED_FILE"
        exit 0
    fi
    log "WARN: bot token send failed, trying webhook (attempt 2)"
fi

# ─── 第2試行: curl Incoming Webhook ───
WEBHOOK_URL="${SLACK_WEBHOOK_URL_R2C:-${SLACK_WEBHOOK_URL:-}}"

send_via_webhook() {
    local url="$1" payload="$2"
    local resp
    resp="$(curl -sS --max-time 15 \
        -X POST \
        -H 'Content-Type: application/json' \
        --data "$payload" \
        "$url" 2>&1)" || return 1
    [[ "$resp" == "ok" ]] || return 1
    return 0
}

if [[ -n "${WEBHOOK_URL:-}" ]]; then
    if send_via_webhook "$WEBHOOK_URL" "$PAYLOAD"; then
        log "Sent via webhook (attempt 2): $MESSAGE"
        [[ "$COLOR" == "error" ]] && touch "$STOP_NOTIFIED_FILE"
        exit 0
    fi
    log "WARN: webhook send failed, falling back to stderr (attempt 3)"
fi

# ─── 第3試行: stderr 書き出し + 終了コード 1 ───
log "ERROR: all Slack send attempts failed for: $MESSAGE"
printf '[%s] [%s] SLACK_SEND_FAILED color=%s channel=%s message=%s\n' \
    "$(ts)" "$SCRIPT_NAME" "$COLOR" "$CHANNEL" "$MESSAGE" >&2
exit 1
