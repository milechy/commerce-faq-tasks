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
#                             [--alert-type <type>]
#                             [--escalation-count <N>]
#                             [--immediate-escalation]
#                             [--reset-alert-type <type>]
#
# 環境変数 (秘匿値は ~/.claude-r2c-config/secrets/r2c-loop.env に保管):
#   SLACK_BOT_TOKEN          — Bot OAuth token xoxb-... (Slack MCP 経由の第1試行)
#   SLACK_WEBHOOK_URL_R2C    — #r2c 専用 Incoming Webhook URL (第2試行 優先)
#   SLACK_WEBHOOK_URL        — 汎用 Incoming Webhook URL (第2試行 フォールバック)
#   SLACK_WEBHOOK_URL_EMERGENCY — escalation 専用 Webhook URL (Q1 設計判断 B案)
#                                  未設定なら既存webhookに &lt;!here&gt; 🚨 ESCALATION:
#                                  prefix 付きでフォールバック (確実通知)
#   ALERT_DB_PATH            — alert counter DB path (default: /tmp/r2c-alert-count.db)
#
# 通知パターン (CLI 自走プロンプト用):
#   PR 作成完了  : notify-slack.sh "✅ PR #N pushed: <title>, ready for Gate 2.5" --color success
#   Gate 失敗    : notify-slack.sh "⚠️ Gate failed at <step>: <error>" --color warning
#   Stop 発火    : notify-slack.sh "🛑 Stopped: <reason>" --color error
#
# Escalation パターン (Phase70 設計判断 Q1-Q3、docs/R2C_DEVELOPMENT_PLAYBOOK.md 参照):
#   通常 alert (counter +1) :
#       notify-slack.sh "[PM2] rajiuce-api restart=55" --alert-type pm2_restart --color warning
#   即時 escalation (counter bypass) :
#       notify-slack.sh "[PM2-EMERGENCY] rajiuce-api restart=120" \
#           --alert-type pm2_restart --immediate-escalation --color error
#   counter 手動リセット (運用ack後) :
#       notify-slack.sh "manual ack" --reset-alert-type pm2_restart --dry-run
#
# 設計 (Phase70 Asana 1214955296965915):
#   - 同一 --alert-type が 5 回連続 (escalation_count 既定値) 未ack で蓄積 → escalation 発火
#   - escalation 後は当該 alert_type の counter をリセット
#   - alert_type 別カウント (種類混在は影響しない)
#   - --immediate-escalation は counter を経由せず即escalation channel送信
#
# セキュリティ注記:
#   - Webhook URL は stderr にも stdout にも出力しない
#   - Stop signal 後の連投防止: ~/.r2c-notified-stop が存在すれば exit 0
#   - sqlite3 が無い環境では counter 機能は no-op 化 (alert は通常送信、escalation 不発火)
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"
DEFAULT_CHANNEL="C0AG07HFJTB"
STOP_NOTIFIED_FILE="${R2C_CONFIG}/.r2c-notified-stop"
ALERT_DB_PATH="${ALERT_DB_PATH:-/tmp/r2c-alert-count.db}"
DEFAULT_ESCALATION_COUNT=5

MESSAGE=""
COLOR="info"
CHANNEL="$DEFAULT_CHANNEL"
DRY_RUN=0
ALERT_TYPE=""
ESCALATION_COUNT="$DEFAULT_ESCALATION_COUNT"
IMMEDIATE_ESCALATION=0
RESET_ALERT_TYPE=""
BYPASS_STOP_DEDUPE=0

usage() {
    cat <<'USAGE'
Usage: notify-slack.sh <message> [--color info|success|warning|error]
                                 [--channel <id>] [--dry-run]
                                 [--alert-type <type>]
                                 [--escalation-count <N>]
                                 [--immediate-escalation]
                                 [--reset-alert-type <type>]
                                 [--bypass-stop-dedupe]
USAGE
}

# ─── 引数パース ───
while [[ $# -gt 0 ]]; do
    case "$1" in
        --color)              COLOR="${2:-info}"; shift 2 ;;
        --channel)            CHANNEL="${2:-$DEFAULT_CHANNEL}"; shift 2 ;;
        --dry-run)            DRY_RUN=1; shift ;;
        --alert-type)         ALERT_TYPE="${2:-}"; shift 2 ;;
        --escalation-count)   ESCALATION_COUNT="${2:-$DEFAULT_ESCALATION_COUNT}"; shift 2 ;;
        --immediate-escalation) IMMEDIATE_ESCALATION=1; shift ;;
        --reset-alert-type)   RESET_ALERT_TYPE="${2:-}"; shift 2 ;;
        --bypass-stop-dedupe) BYPASS_STOP_DEDUPE=1; shift ;;
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

# --reset-alert-type は単独で実行可能 (message 不要)
if [[ -n "$RESET_ALERT_TYPE" ]] && [[ -z "$MESSAGE" ]]; then
    MESSAGE="(reset-only)"
fi

if [[ -z "$MESSAGE" ]]; then
    echo "ERROR: <message> required" >&2
    usage; exit 1
fi

if ! [[ "$ESCALATION_COUNT" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: --escalation-count must be positive integer (got: $ESCALATION_COUNT)" >&2
    exit 1
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
# --bypass-stop-dedupe 指定時はスキップ (safety-critical path 専用 opt-in)
if [[ "$COLOR" == "error" ]] && [[ "$BYPASS_STOP_DEDUPE" -eq 0 ]] && [[ -f "$STOP_NOTIFIED_FILE" ]]; then
    echo "[${SCRIPT_NAME}] Stop already notified, skipping duplicate." >&2
    exit 0
fi

mkdir -p "$LOG_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] [%s] %s\n' "$(ts)" "$SCRIPT_NAME" "$*"; }

# ─── Alert counter (sqlite3 backed) ───
# sqlite3 が無い環境では関数を no-op 化 (alert は通常送信、escalation は不発火)
HAS_SQLITE=0
if command -v sqlite3 >/dev/null 2>&1; then
    HAS_SQLITE=1
fi

db_init() {
    [[ "$HAS_SQLITE" -eq 0 ]] && return 0
    sqlite3 "$ALERT_DB_PATH" <<'SQL' 2>/dev/null || true
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  escalated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_type_escalated
  ON alerts(alert_type, escalated);
SQL
}

# DB に alert を1件記録 (escalated=0)
db_record_alert() {
    local atype="$1" msg="$2"
    [[ "$HAS_SQLITE" -eq 0 ]] && return 0
    db_init
    local esc_msg
    esc_msg="$(printf '%s' "$msg" | sed "s/'/''/g")"
    sqlite3 "$ALERT_DB_PATH" \
        "INSERT INTO alerts (alert_type, message, created_at) VALUES ('${atype}', '${esc_msg}', $(date +%s));" 2>/dev/null || true
}

# 同種 unescalated alert の件数を返す
db_count_unescalated() {
    local atype="$1"
    [[ "$HAS_SQLITE" -eq 0 ]] && { echo 0; return; }
    db_init
    sqlite3 "$ALERT_DB_PATH" \
        "SELECT COUNT(*) FROM alerts WHERE alert_type='${atype}' AND escalated=0;" 2>/dev/null \
        || echo 0
}

# escalation 後: 同種 alert を全て escalated=1 に更新
db_mark_escalated() {
    local atype="$1"
    [[ "$HAS_SQLITE" -eq 0 ]] && return 0
    db_init
    sqlite3 "$ALERT_DB_PATH" \
        "UPDATE alerts SET escalated=1 WHERE alert_type='${atype}' AND escalated=0;" 2>/dev/null || true
}

# 手動 reset (運用 ack 用)
db_reset_alert_type() {
    local atype="$1"
    [[ "$HAS_SQLITE" -eq 0 ]] && return 0
    db_init
    sqlite3 "$ALERT_DB_PATH" \
        "DELETE FROM alerts WHERE alert_type='${atype}';" 2>/dev/null || true
}

# ─── ペイロード構築 (Attachment 形式、color 対応) ───
# 注意: send_escalation が dry-run でも呼べるよう exec >> redirect の前に定義
build_payload_json() {
    local channel="$1" message="$2" hex_color="$3"
    printf '{"channel":"%s","attachments":[{"color":"%s","text":"%s","mrkdwn_in":["text"]}]}' \
        "$channel" "$hex_color" \
        "$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# escalation message 構築 (件数 / alert_type 情報を付与)
build_escalation_message() {
    local atype="$1" original="$2" count="$3" reason="$4"
    # reason: "immediate" / "threshold"
    if [[ "$reason" == "immediate" ]]; then
        printf '<!here> 🚨 ESCALATION [%s-IMMEDIATE] %s' "$atype" "$original"
    else
        printf '<!here> 🚨 ESCALATION [%s] %s (同種 %d 件連続検知 — 閾値 %d)' \
            "$atype" "$original" "$count" "$ESCALATION_COUNT"
    fi
}

# escalation 送信 (Webhook URL の解決を含む)
send_escalation() {
    local esc_msg="$1"
    local esc_payload esc_webhook esc_channel
    # Q1 設計: SLACK_WEBHOOK_URL_EMERGENCY 優先、なければ既存webhookに prefix 付きでフォールバック
    esc_webhook="${SLACK_WEBHOOK_URL_EMERGENCY:-${SLACK_WEBHOOK_URL_R2C:-${SLACK_WEBHOOK_URL:-}}}"
    esc_channel="${SLACK_CHANNEL_EMERGENCY:-$CHANNEL}"
    esc_payload="$(build_payload_json "$esc_channel" "$esc_msg" "#cc0000")"

    if [[ "$DRY_RUN" -eq 1 ]]; then
        log "[dry-run] ESCALATION: $esc_msg"
        return 0
    fi

    # 第1試行: bot token (chat.postMessage)
    if [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
        if send_via_bot_token "$SLACK_BOT_TOKEN" "$esc_payload"; then
            log "ESCALATION sent via bot token: $esc_msg"
            return 0
        fi
    fi
    # 第2試行: webhook (emergency 優先)
    if [[ -n "$esc_webhook" ]]; then
        if send_via_webhook "$esc_webhook" "$esc_payload"; then
            log "ESCALATION sent via webhook: $esc_msg"
            return 0
        fi
    fi
    log "ERROR: ESCALATION send failed: $esc_msg"
    return 1
}

# ─── --reset-alert-type 単独処理 (送信前に handle) ───
if [[ -n "$RESET_ALERT_TYPE" ]]; then
    db_reset_alert_type "$RESET_ALERT_TYPE"
    log "Reset alert counter for type: $RESET_ALERT_TYPE"
    # message が "(reset-only)" なら送信せず終了
    if [[ "$MESSAGE" == "(reset-only)" ]]; then
        exit 0
    fi
fi

# ─── Dry-run ───
# 注意: dry-run でも counter (DB) + escalation 判定は実行する。
#       (テストランナーで動作確認できるよう / send_escalation は内部 DRY_RUN guard で curl skip)
DRY_RUN_EXIT_AFTER_CHECK=0
if [[ "$DRY_RUN" -eq 1 ]]; then
    cat <<DRY
[dry-run] notify-slack.sh
  channel    : $CHANNEL
  color      : $COLOR ($HEX_COLOR)
  message    : $MESSAGE
  alert_type : ${ALERT_TYPE:-(none)}
  esc_count  : $ESCALATION_COUNT
  immediate  : $IMMEDIATE_ESCALATION
DRY
    DRY_RUN_EXIT_AFTER_CHECK=1
fi

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

post_send_escalation_check() {
    # primary send が成功した後の escalation 処理
    # --alert-type 未指定なら何もしない (後方互換)
    [[ -z "$ALERT_TYPE" ]] && return 0

    if [[ "$IMMEDIATE_ESCALATION" -eq 1 ]]; then
        local esc_msg
        esc_msg="$(build_escalation_message "$ALERT_TYPE" "$MESSAGE" 1 "immediate")"
        send_escalation "$esc_msg" || true
        # immediate escalation 後も該当 type の未ack alert はクリア
        db_mark_escalated "$ALERT_TYPE"
        return 0
    fi

    # 通常 path: counter +1 → threshold 判定
    db_record_alert "$ALERT_TYPE" "$MESSAGE"
    local cnt
    cnt="$(db_count_unescalated "$ALERT_TYPE")"
    log "alert_type=$ALERT_TYPE unescalated_count=$cnt threshold=$ESCALATION_COUNT"
    if [[ "$cnt" -ge "$ESCALATION_COUNT" ]]; then
        local esc_msg
        esc_msg="$(build_escalation_message "$ALERT_TYPE" "$MESSAGE" "$cnt" "threshold")"
        if send_escalation "$esc_msg"; then
            db_mark_escalated "$ALERT_TYPE"
        fi
    fi
}

# Dry-run: 実 curl は飛ばさず、counter + escalation 判定だけ動かす
# (exec >> log redirect の前で実行 → 出力が stdout に残り、テストで検証可能)
if [[ "$DRY_RUN_EXIT_AFTER_CHECK" -eq 1 ]]; then
    log "[dry-run] skipping primary send; running counter/escalation check only"
    post_send_escalation_check
    exit 0
fi

# 本番送信パスは log file へ集約 (curl の noise を log に閉じ込める)
exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1

if [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
    if send_via_bot_token "$SLACK_BOT_TOKEN" "$PAYLOAD"; then
        log "Sent via bot token (attempt 1): $MESSAGE"
        [[ "$COLOR" == "error" ]] && touch "$STOP_NOTIFIED_FILE"
        post_send_escalation_check
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
        post_send_escalation_check
        exit 0
    fi
    log "WARN: webhook send failed, falling back to stderr (attempt 3)"
fi

# ─── 第3試行: stderr 書き出し + 終了コード 1 ───
log "ERROR: all Slack send attempts failed for: $MESSAGE"
printf '[%s] [%s] SLACK_SEND_FAILED color=%s channel=%s message=%s\n' \
    "$(ts)" "$SCRIPT_NAME" "$COLOR" "$CHANNEL" "$MESSAGE" >&2
exit 1
