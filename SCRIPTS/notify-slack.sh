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
    # v2 schema: delivery_status / retry_count / last_attempt_at 列を追加
    # WAL mode: 同時 cron 実行時の lock 競合回避 (memory#14, 先回り 1)
    # 注意: PRAGMA 設定値は stdout に出力されるので >/dev/null で抑制 (caller 側捕捉汚染防止)
    sqlite3 "$ALERT_DB_PATH" <<'SQL' >/dev/null 2>&1 || true
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  escalated INTEGER NOT NULL DEFAULT 0,
  delivery_status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  last_attempt_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_type_escalated
  ON alerts(alert_type, escalated);
SQL
    # v1 → v2 in-place migration (列がなければ ADD、あれば errno 1 で no-op)
    for col_def in \
        "delivery_status TEXT DEFAULT 'pending'" \
        "retry_count INTEGER DEFAULT 0" \
        "last_attempt_at INTEGER"; do
        sqlite3 "$ALERT_DB_PATH" "ALTER TABLE alerts ADD COLUMN ${col_def};" >/dev/null 2>&1 || true
    done
}

# DB に alert を1件記録 → rowid を stdout に出力 (空文字なら sqlite3 不在 or 失敗)
# 先回り 1: BEGIN IMMEDIATE + busy_timeout で同時 cron 実行時のロスト書き込みを防止。
# busy_timeout は per-connection 設定のため、各 sqlite3 呼び出しで明示する。
db_record_alert() {
    local atype="$1" msg="$2"
    [[ "$HAS_SQLITE" -eq 0 ]] && { echo ""; return 0; }
    db_init
    local esc_msg
    esc_msg="$(printf '%s' "$msg" | sed "s/'/''/g")"
    local now
    now="$(date +%s)"
    # PRAGMA busy_timeout=5000 は "5000" を stdout に出力するため、
    # SELECT last_insert_rowid() の結果と混ざる。tail -1 で最終行 (rowid) のみ取り出す。
    local out
    out="$(sqlite3 "$ALERT_DB_PATH" <<SQL 2>/dev/null
PRAGMA busy_timeout=5000;
BEGIN IMMEDIATE;
INSERT INTO alerts (alert_type, message, created_at, delivery_status, last_attempt_at)
  VALUES ('${atype}', '${esc_msg}', ${now}, 'pending', ${now});
SELECT last_insert_rowid();
COMMIT;
SQL
)"
    printf '%s' "$out" | tail -n 1
}

# rowid の delivery_status を更新 (delivered / failed)
db_update_delivery_status() {
    local rowid="$1" status="$2"
    [[ "$HAS_SQLITE" -eq 0 ]] && return 0
    [[ -z "$rowid" ]] && return 0
    db_init
    sqlite3 "$ALERT_DB_PATH" <<SQL >/dev/null 2>&1 || true
PRAGMA busy_timeout=5000;
UPDATE alerts SET delivery_status='${status}', last_attempt_at=$(date +%s) WHERE id=${rowid};
SQL
}

# 同種 unescalated alert の件数を返す (delivery_status は問わない — alert 発生事実が threshold 対象)
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
    sqlite3 "$ALERT_DB_PATH" <<SQL >/dev/null 2>&1 || true
PRAGMA busy_timeout=5000;
UPDATE alerts SET escalated=1 WHERE alert_type='${atype}' AND escalated=0;
SQL
}

# 手動 reset (運用 ack 用)
db_reset_alert_type() {
    local atype="$1"
    [[ "$HAS_SQLITE" -eq 0 ]] && return 0
    db_init
    sqlite3 "$ALERT_DB_PATH" <<SQL >/dev/null 2>&1 || true
PRAGMA busy_timeout=5000;
DELETE FROM alerts WHERE alert_type='${atype}';
SQL
}

# 先回り 3: delivery_failed の stderr を rate-limit (同一 key で 5 分 1 回まで)
# R2C_CONFIG/delivery-fail-locks/ にロックファイル (mtime ベース)
log_delivery_failure_rate_limited() {
    local key="$1" msg="$2"
    local lock_dir="${R2C_CONFIG}/delivery-fail-locks"
    mkdir -p "$lock_dir" 2>/dev/null || true
    local key_hash
    key_hash="$(printf '%s' "$key" | shasum -a 1 2>/dev/null | awk '{print $1}')"
    [[ -z "$key_hash" ]] && key_hash="default"
    local lock="$lock_dir/$key_hash"
    local now mtime age
    now="$(date +%s)"
    if [[ -f "$lock" ]]; then
        mtime="$(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || echo 0)"
        age=$((now - mtime))
        if [[ "$age" -lt 300 ]]; then
            return 0
        fi
    fi
    touch "$lock"
    printf '%s\n' "$msg" >&2
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
    # Test-only hook: escalation-test.sh T14 (immediate-escalation 失敗時の挙動検証)
    # dry-run guard より前に評価することでテストから強制 fail させられる
    if [[ -n "${R2C_TEST_FORCE_ESCALATION_FAIL:-}" ]]; then
        log "ERROR: [test-forced] ESCALATION send failed: $esc_msg"
        return 1
    fi
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

# ─── Pre-send: alert 発生事実を確実に DB へ記録 (Fix 2) ───
# Codex Round 2 high #2: primary send が失敗しても alert は counter に積まれるべき。
# transport 障害時にも escalation threshold が正常に評価されるよう、
# 送信試行の前に record しておく (rowid は後で delivery_status 更新に使う)。
RECORDED_ROWID=""
if [[ -n "$ALERT_TYPE" ]]; then
    RECORDED_ROWID="$(db_record_alert "$ALERT_TYPE" "$MESSAGE")"
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

# immediate-escalation 専用 handler
# Fix 1 (Codex Round 2 high): send_escalation 成功時のみ db_mark_escalated を呼ぶ。
#                             失敗時は backlog (escalated=0) を保持し次回呼び出しで再評価可能にする。
handle_immediate_escalation() {
    [[ "$IMMEDIATE_ESCALATION" -eq 1 ]] || return 0
    [[ -z "$ALERT_TYPE" ]] && return 0
    local esc_msg
    esc_msg="$(build_escalation_message "$ALERT_TYPE" "$MESSAGE" 1 "immediate")"
    if send_escalation "$esc_msg"; then
        db_mark_escalated "$ALERT_TYPE"
        return 0
    fi
    log "ERROR: immediate ESCALATION send failed; backlog preserved for alert_type=$ALERT_TYPE"
    return 1
}

# threshold-based escalation check (通常 alert path 専用)
# Fix 2 (Codex Round 2 high): db_record_alert は呼び出し側で pre-send 実行済み。
#                             ここでは threshold 判定 + send_escalation のみ。
post_send_escalation_check() {
    [[ -z "$ALERT_TYPE" ]] && return 0
    [[ "$IMMEDIATE_ESCALATION" -eq 1 ]] && return 0  # immediate path は handle_immediate_escalation で処理
    local cnt
    cnt="$(db_count_unescalated "$ALERT_TYPE")"
    log "alert_type=$ALERT_TYPE unescalated_count=$cnt threshold=$ESCALATION_COUNT"
    if [[ "$cnt" -ge "$ESCALATION_COUNT" ]]; then
        local esc_msg
        esc_msg="$(build_escalation_message "$ALERT_TYPE" "$MESSAGE" "$cnt" "threshold")"
        if send_escalation "$esc_msg"; then
            db_mark_escalated "$ALERT_TYPE"
        else
            log "WARN: threshold ESCALATION send failed; backlog preserved (count=$cnt threshold=$ESCALATION_COUNT)"
        fi
    fi
}

# Dry-run: 実 curl は飛ばさず、counter + escalation 判定だけ動かす
# (exec >> log redirect の前で実行 → 出力が stdout に残り、テストで検証可能)
if [[ "$DRY_RUN_EXIT_AFTER_CHECK" -eq 1 ]]; then
    log "[dry-run] skipping primary send; running counter/escalation check only"
    db_update_delivery_status "$RECORDED_ROWID" "delivered"
    handle_immediate_escalation || true
    post_send_escalation_check
    exit 0
fi

# webhook send 関数 (第2試行) — dispatch ロジックより前に定義する必要があるので定義のみ移動済み
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

# 本番送信パスは log file へ集約 (curl の noise を log に閉じ込める)
exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1

PRIMARY_SENT=0

# ─── 第1試行: Slack Bot Token (chat.postMessage) ───
if [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
    if send_via_bot_token "$SLACK_BOT_TOKEN" "$PAYLOAD"; then
        log "Sent via bot token (attempt 1): $MESSAGE"
        [[ "$COLOR" == "error" ]] && touch "$STOP_NOTIFIED_FILE"
        PRIMARY_SENT=1
    else
        log "WARN: bot token send failed, trying webhook (attempt 2)"
    fi
fi

# ─── 第2試行: curl Incoming Webhook ───
WEBHOOK_URL="${SLACK_WEBHOOK_URL_R2C:-${SLACK_WEBHOOK_URL:-}}"
if [[ "$PRIMARY_SENT" -eq 0 ]] && [[ -n "${WEBHOOK_URL:-}" ]]; then
    if send_via_webhook "$WEBHOOK_URL" "$PAYLOAD"; then
        log "Sent via webhook (attempt 2): $MESSAGE"
        [[ "$COLOR" == "error" ]] && touch "$STOP_NOTIFIED_FILE"
        PRIMARY_SENT=1
    else
        log "WARN: webhook send failed, falling back to stderr (attempt 3)"
    fi
fi

if [[ "$PRIMARY_SENT" -eq 1 ]]; then
    db_update_delivery_status "$RECORDED_ROWID" "delivered"
    handle_immediate_escalation || true
    post_send_escalation_check
    exit 0
fi

# ─── 全 transport 失敗 (Fix 2: alert recording / escalation 評価は維持) ───
# - DB の delivery_status を 'failed' に更新 (alert 自体は record 済み)
# - escalation 評価は実行 (counter は increment 済みなので threshold 評価可)
# - stderr 出力は rate-limit (5 分 1 回/key) で flood を回避 (先回り 3)
db_update_delivery_status "$RECORDED_ROWID" "failed"

log "ERROR: all Slack send attempts failed for: $MESSAGE"
log_delivery_failure_rate_limited \
    "primary_send_${ALERT_TYPE:-none}_${COLOR}" \
    "[$(ts)] [${SCRIPT_NAME}] SLACK_SEND_FAILED color=${COLOR} channel=${CHANNEL} alert_type=${ALERT_TYPE:-(none)} message=${MESSAGE}"

# delivery 失敗でも escalation 評価は走らせる:
# - immediate: send_escalation が同じく fail するなら mark_escalated されず backlog 維持
# - threshold: counter は record 済みなので評価可能、send_escalation 失敗時は backlog 維持
handle_immediate_escalation || true
post_send_escalation_check

exit 1
