#!/usr/bin/env bash
# external-healthcheck.sh — VPS 外から /health を叩く dead-man's-switch 型死活監視
#
# なぜ必要か / どこで動かすか:
#   UptimeRobot（外部SaaS）が使えない・使いたくない場合の代替。
#   **必ず監視対象(VPS)の外側で動かす。** VPS 上で動かすと、VPS が落ちたときに
#   このスクリプトも一緒に死に、誰にも通知されない（＝監視の意味が無い）。
#   想定実行環境:
#     - 別ホスト / 自宅マシン / 別 VPS の cron
#     - GitHub Actions の schedule（VPS とは完全に独立した第三者インフラ）
#     - ローカルの launchd/cron
#
#   連続 N 回失敗して初めて通知する（単発のネットワーク瞬断で騒がない）。
#   失敗回数は状態ファイルに持ち越すので、5分間隔 cron 等で回す前提。
#   復旧したら「復旧」を1回だけ通知してカウンタをリセットする。
#
# 設計上の約束:
#   - シークレット（webhook URL）をログ・stdout に出さない。
#   - 依存は curl のみ（jq 不要）。POSIX 寄りに書き、どのホストでも動くように。
#
# 使い方:
#   bash SCRIPTS/external-healthcheck.sh
#   HEALTHCHECK_URL=https://api.r2c.biz/health FAIL_THRESHOLD=3 \
#     ALERT_WEBHOOK_URL='https://hooks.slack.com/services/...' \
#     bash SCRIPTS/external-healthcheck.sh
#
# 環境変数:
#   HEALTHCHECK_URL    — 監視する URL（既定 https://api.r2c.biz/health）
#   EXPECT_STATUS      — 期待 HTTP ステータス（既定 200）
#   EXPECT_BODY        — 応答本文に含まれるべき文字列（任意。既定 未指定=本文は見ない）
#   TIMEOUT_SEC        — 1回あたりのタイムアウト秒（既定 15）
#   FAIL_THRESHOLD     — 連続何回失敗で通知するか（既定 3）
#   ALERT_WEBHOOK_URL  — 失敗/復旧を送る汎用 webhook（Slack Incoming Webhook 等）。
#                        未設定なら stderr にのみ出力（GitHub Actions のログには残る）。
#   STATE_FILE         — 連続失敗回数の保存先（既定 /tmp/r2c-external-healthcheck.state）
#   MONITOR_LABEL      — 通知に付ける対象名（既定: URL のホスト名）
#
# 関連: SCRIPTS/setup-uptime-monitoring.sh / docs/BACKUP_AND_MONITORING.md
#
# GitHub Actions で回す例（VPS とは独立に動く。secrets に webhook を置く）:
#   # .github/workflows/external-healthcheck.yml
#   on:
#     schedule: [{ cron: '*/5 * * * *' }]   # 5分毎（GHA cron はUTC・多少遅延あり）
#   jobs:
#     ping:
#       runs-on: ubuntu-latest
#       steps:
#         - uses: actions/checkout@v4
#         - env:
#             ALERT_WEBHOOK_URL: ${{ secrets.HEALTHCHECK_WEBHOOK_URL }}
#             FAIL_THRESHOLD: '2'   # GHA は状態を持ち越さないので閾値は小さめ+連続実行前提
#           run: bash SCRIPTS/external-healthcheck.sh
#   ※ GHA は実行毎に状態がリセットされる点に注意。厳密な連続失敗判定が要るなら
#     常駐ホストの cron + STATE_FILE 永続化を推奨。

set -uo pipefail

HEALTHCHECK_URL="${HEALTHCHECK_URL:-https://api.r2c.biz/health}"
EXPECT_STATUS="${EXPECT_STATUS:-200}"
EXPECT_BODY="${EXPECT_BODY:-}"
TIMEOUT_SEC="${TIMEOUT_SEC:-15}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
STATE_FILE="${STATE_FILE:-/tmp/r2c-external-healthcheck.state}"

# 既定の対象名は URL のホスト名（スキームと path を除去）。
_host="${HEALTHCHECK_URL#*://}"; _host="${_host%%/*}"
MONITOR_LABEL="${MONITOR_LABEL:-$_host}"

command -v curl >/dev/null 2>&1 || { echo "ERROR: curl が必要です" >&2; exit 1; }
case "$FAIL_THRESHOLD" in
    ''|*[!0-9]*) echo "ERROR: FAIL_THRESHOLD は正の整数で指定してください（got: $FAIL_THRESHOLD）" >&2; exit 1 ;;
esac

log() { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $*"; }

# webhook 送信。URL は絶対にログ/stdout に出さない。
# メッセージだけを JSON の text フィールドに入れて POST する（Slack 互換）。
notify() {
    local text="$1"
    log "$text"   # ログには本文のみ（URL は出さない）
    [ -n "$ALERT_WEBHOOK_URL" ] || return 0
    # JSON 用に最小限のエスケープ（" と \ と改行）。
    local esc="$text"
    esc="${esc//\\/\\\\}"; esc="${esc//\"/\\\"}"; esc="${esc//$'\n'/ }"
    curl -sS --max-time 15 -X POST \
        -H 'Content-Type: application/json' \
        --data "{\"text\":\"${esc}\"}" \
        "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 \
        || log "警告: webhook 送信に失敗しました（監視自体は継続）" >&2
}

read_fail_count() {
    [ -f "$STATE_FILE" ] || { echo 0; return; }
    local v; v="$(head -1 "$STATE_FILE" 2>/dev/null | tr -cd '0-9')"
    [ -n "$v" ] && echo "$v" || echo 0
}
write_fail_count() { echo "$1" > "$STATE_FILE" 2>/dev/null || true; }

# ── 1回叩く。ステータスと（指定あれば）本文を判定 ──────────────
# -w でステータスを末尾に付け、本文と分離する。接続失敗は curl 自体が非ゼロ。
BODY_AND_CODE="$(curl -sS --max-time "$TIMEOUT_SEC" -w $'\n%{http_code}' "$HEALTHCHECK_URL" 2>/dev/null)"
CURL_RC=$?
HTTP_CODE="$(printf '%s' "$BODY_AND_CODE" | tail -1)"
BODY="$(printf '%s' "$BODY_AND_CODE" | sed '$d')"

OK=1
REASON=""
if [ "$CURL_RC" -ne 0 ]; then
    OK=0; REASON="接続失敗（curl rc=${CURL_RC}, timeout=${TIMEOUT_SEC}s）"
elif [ "$HTTP_CODE" != "$EXPECT_STATUS" ]; then
    OK=0; REASON="HTTP ${HTTP_CODE}（期待 ${EXPECT_STATUS}）"
elif [ -n "$EXPECT_BODY" ]; then
    case "$BODY" in
        *"$EXPECT_BODY"*) : ;;
        *) OK=0; REASON="応答本文に '${EXPECT_BODY}' が含まれません" ;;
    esac
fi

PREV_FAILS="$(read_fail_count)"

if [ "$OK" -eq 1 ]; then
    if [ "$PREV_FAILS" -ge "$FAIL_THRESHOLD" ]; then
        notify "✅ 復旧: ${MONITOR_LABEL} が正常に応答しました（${HEALTHCHECK_URL}）"
    fi
    write_fail_count 0
    log "OK: ${MONITOR_LABEL} → HTTP ${HTTP_CODE}"
    exit 0
fi

# 失敗: カウンタを進める。閾値に達した瞬間に1回だけ通知する（連投しない）。
NEW_FAILS=$((PREV_FAILS + 1))
write_fail_count "$NEW_FAILS"
log "FAIL(${NEW_FAILS}/${FAIL_THRESHOLD}): ${MONITOR_LABEL} → ${REASON}"

if [ "$NEW_FAILS" -eq "$FAIL_THRESHOLD" ]; then
    notify "🔴 死活監視アラート: ${MONITOR_LABEL} が ${FAIL_THRESHOLD} 回連続で失敗しました（${REASON}）。URL: ${HEALTHCHECK_URL}"
elif [ "$NEW_FAILS" -gt "$FAIL_THRESHOLD" ]; then
    log "（閾値超過は通知済み。連投抑制中。復旧時に1回通知します）"
fi

# 死活監視の「失敗」はスクリプトとしては正常動作なので終了コードで区別する:
#   2 = 監視対象が異常（アラート条件）／0 = 監視対象は正常
exit 2
