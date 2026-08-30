#!/usr/bin/env bash
# setup-uptime-monitoring.sh — UptimeRobot に外部死活監視を作成/更新（冪等）
#
# なぜ必要か:
#   2026-08 の監査で、外部からの死活監視が1つも無いことが判明した。
#   現状の監視（PM2・cron・/health を叩く gate スクリプト）は **すべて VPS 上**で
#   動いている。VPS が全損すると、監視も通知経路も同時に死ぬため、誰も気づけない。
#   死活監視は必ず **監視対象の外側**（第三者の SaaS もしくは別ホスト）から行う。
#   このスクリプトは UptimeRobot（外部SaaS）に HTTP 監視を登録/更新する。
#
# 実行場所: どこからでも可（API を叩くだけ。VPS でなくてよい）。一度きりのセットアップ。
#
# 冪等性:
#   同名（friendly_name）のモニタが既に在れば editMonitor で更新、
#   無ければ newMonitor で作成する。何度流しても重複を作らない。
#
# 設計上の約束（notify-slack.sh / backup-postgres.sh の規律を踏襲）:
#   - .env を source しない。必要な変数だけ取り出す。
#   - UPTIMEROBOT_API_KEY をログ・エラー・URL 文字列に出さない
#     （POST body で送るのみ。エラー本文もサニタイズする）。
#   - API キー未設定なら実行せず、手順を表示して終了（破壊的操作をしない）。
#
# 使い方:
#   bash SCRIPTS/setup-uptime-monitoring.sh            # 監視を作成/更新
#   bash SCRIPTS/setup-uptime-monitoring.sh --dry-run  # 送信内容を表示するのみ（API 叩かない）
#   bash SCRIPTS/setup-uptime-monitoring.sh --list     # 既存モニタ一覧（API キー必要）
#
# 必要な環境変数（.env もしくは CI secrets。スクリプトには書かない）:
#   UPTIMEROBOT_API_KEY          — UptimeRobot の Main API Key（必須。u... で始まる）
#   UPTIMEROBOT_ALERT_CONTACT_ID — 通知先の alert contact id（任意。未設定なら既存の既定連絡先）
#   MONITOR_INTERVAL_SEC         — 監視間隔秒（既定 300 = 5分。無料枠の下限）
#   MONITOR_API_URL              — 公開 API の health（既定 https://api.r2c.biz/health）
#   MONITOR_ADMIN_URL            — 管理UI（既定 https://admin.r2c.biz）
#   MONITOR_WIDGET_URL           — widget 配信（任意。設定時のみ監視を追加）
#
# 関連: SCRIPTS/external-healthcheck.sh（SaaS を使わない代替）/ docs/BACKUP_AND_MONITORING.md

set -uo pipefail

ENV_FILE="${ENV_FILE:-/opt/rajiuce/.env}"
API_BASE="https://api.uptimerobot.com/v2"
MONITOR_INTERVAL_SEC="${MONITOR_INTERVAL_SEC:-300}"
MONITOR_API_URL="${MONITOR_API_URL:-https://api.r2c.biz/health}"
MONITOR_ADMIN_URL="${MONITOR_ADMIN_URL:-https://admin.r2c.biz}"
MONITOR_WIDGET_URL="${MONITOR_WIDGET_URL:-}"
# モニタ名の接頭辞。冪等判定（既存検索）のキーにもなる。
NAME_PREFIX="R2C"

MODE=run
case "${1:-}" in
  --dry-run) MODE=dry ;;
  --list)    MODE=list ;;
  "")        ;;
  -h|--help) echo "使い方: $0 [--dry-run|--list]"; exit 0 ;;
  *) echo "使い方: $0 [--dry-run|--list]" >&2; exit 64 ;;
esac

log() { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $*"; }

load_env_var() {
    [ -f "$ENV_FILE" ] || return 0
    sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^"//; s/"$//'
}

# API キー未設定時に表示する手順（破壊的操作はしない）。
print_setup_help() {
    cat <<'HELP'
UptimeRobot の API キーが設定されていません。以下の手順で用意してください:

  1) https://uptimerobot.com にサインアップ（無料枠で 50 モニタ / 5分間隔まで可）
  2) My Settings → API Settings → "Main API Key" を作成
  3) その値を .env もしくは CI secrets に設定（スクリプトには書かない）:
       UPTIMEROBOT_API_KEY=u123456-xxxxxxxxxxxxxxxxxxxxxxxx
  4) （任意）通知先を Slack/メール等で作成し、その alert contact id を:
       UPTIMEROBOT_ALERT_CONTACT_ID=1234567
  5) 再実行:
       bash SCRIPTS/setup-uptime-monitoring.sh --dry-run   # 送信内容の確認
       bash SCRIPTS/setup-uptime-monitoring.sh             # 作成/更新

SaaS を使えない/使いたくない場合は、別ホストや GitHub Actions から回す
SCRIPTS/external-healthcheck.sh を使ってください（docs/BACKUP_AND_MONITORING.md）。
HELP
}

# UPTIMEROBOT_API_KEY をエラー本文から除去する（防御的多重化）。
sanitize() {
    local text="$1"
    [ -n "${UPTIMEROBOT_API_KEY:-}" ] && text="${text//"$UPTIMEROBOT_API_KEY"/***}"
    printf '%s' "$text"
}

command -v curl >/dev/null 2>&1 || { echo "ERROR: curl が必要です" >&2; exit 1; }

UPTIMEROBOT_API_KEY="${UPTIMEROBOT_API_KEY:-$(load_env_var UPTIMEROBOT_API_KEY)}"
UPTIMEROBOT_ALERT_CONTACT_ID="${UPTIMEROBOT_ALERT_CONTACT_ID:-$(load_env_var UPTIMEROBOT_ALERT_CONTACT_ID)}"

if [ -z "$UPTIMEROBOT_API_KEY" ] && [ "$MODE" != "dry" ]; then
    print_setup_help
    exit 1
fi

# UptimeRobot v2 API 呼び出し（application/x-www-form-urlencoded, JSON 応答）。
# API キーは body でのみ送る。URL には載せない。
ur_call() {
    local endpoint="$1"; shift
    curl -sS --max-time 30 \
        -X POST "${API_BASE}/${endpoint}" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        -H 'Cache-Control: no-cache' \
        --data-urlencode "api_key=${UPTIMEROBOT_API_KEY}" \
        --data-urlencode 'format=json' \
        "$@"
}

json_get() {
    # 依存を増やさないための最小 JSON 抽出。jq があれば使う。
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$1" | jq -r "$2" 2>/dev/null
    else
        printf '%s' "$1" | grep -oE "\"${3}\"[: ]*\"?[^,\"}]*\"?" | head -1 | sed -E 's/.*[: ]//; s/"//g'
    fi
}

# ── --list ───────────────────────────────────────────────────
if [ "$MODE" = "list" ]; then
    [ -n "$UPTIMEROBOT_API_KEY" ] || { print_setup_help; exit 1; }
    RESP="$(ur_call getMonitors)"
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$RESP" | jq -r '.monitors[]? | "\(.id)\t\(.friendly_name)\t\(.url)\t状態=\(.status)"' 2>/dev/null \
            || { echo "ERROR: 一覧取得に失敗: $(sanitize "$RESP" | head -c 300)" >&2; exit 1; }
    else
        printf '%s\n' "$(sanitize "$RESP")"
    fi
    exit 0
fi

# ── 監視対象の組み立て ───────────────────────────────────────
# "名前|URL" の配列。widget は URL が設定されている時だけ含める。
MONITORS=(
    "${NAME_PREFIX} API health|${MONITOR_API_URL}"
    "${NAME_PREFIX} Admin UI|${MONITOR_ADMIN_URL}"
)
[ -n "$MONITOR_WIDGET_URL" ] && MONITORS+=("${NAME_PREFIX} Widget|${MONITOR_WIDGET_URL}")

# 既存モニタを一括取得（冪等判定に使う）。dry-run では API を叩かない。
EXISTING_JSON=""
if [ "$MODE" != "dry" ]; then
    EXISTING_JSON="$(ur_call getMonitors)"
    STAT="$(json_get "$EXISTING_JSON" '.stat' 'stat')"
    if [ "$STAT" != "ok" ]; then
        echo "ERROR: UptimeRobot API 認証/呼び出しに失敗しました（API キーを確認。値は表示しません）: $(sanitize "$EXISTING_JSON" | head -c 300)" >&2
        exit 1
    fi
fi

# 既存モニタ名 → id を引く（jq がある時のみ厳密。無ければ常に新規作成を試みる）。
find_existing_id() {
    local name="$1"
    [ -n "$EXISTING_JSON" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0
    printf '%s' "$EXISTING_JSON" | jq -r --arg n "$name" '.monitors[]? | select(.friendly_name==$n) | .id' 2>/dev/null | head -1
}

CREATED=0; UPDATED=0
for entry in "${MONITORS[@]}"; do
    name="${entry%%|*}"
    url="${entry#*|}"

    if [ "$MODE" = "dry" ]; then
        log "dry-run: 監視 '${name}' → ${url} / 間隔 ${MONITOR_INTERVAL_SEC}秒 / 通知先 ${UPTIMEROBOT_ALERT_CONTACT_ID:-(既定)}"
        continue
    fi

    existing_id="$(find_existing_id "$name")"

    # 共通パラメータ。type=1(HTTP), 間隔, （あれば）通知先。
    args=(--data-urlencode "friendly_name=${name}"
          --data-urlencode "url=${url}"
          --data-urlencode "interval=${MONITOR_INTERVAL_SEC}")
    [ -n "$UPTIMEROBOT_ALERT_CONTACT_ID" ] \
        && args+=(--data-urlencode "alert_contacts=${UPTIMEROBOT_ALERT_CONTACT_ID}_0_0")

    if [ -n "$existing_id" ]; then
        RESP="$(ur_call editMonitor --data-urlencode "id=${existing_id}" "${args[@]}")"
        action="更新"
    else
        RESP="$(ur_call newMonitor --data-urlencode "type=1" "${args[@]}")"
        action="作成"
    fi

    if [ "$(json_get "$RESP" '.stat' 'stat')" = "ok" ]; then
        log "${action}OK: '${name}' → ${url}"
        [ "$action" = "作成" ] && CREATED=$((CREATED+1)) || UPDATED=$((UPDATED+1))
    else
        # 既存を newMonitor しようとして重複エラーになった場合の説明を添える。
        echo "ERROR: '${name}' の${action}に失敗: $(sanitize "$RESP" | head -c 300)" >&2
        echo "  （jq 未導入だと既存判定ができず newMonitor→重複エラーになります。jq 導入を推奨）" >&2
        exit 1
    fi
done

if [ "$MODE" = "dry" ]; then
    log "dry-run 完了: 上記を作成/更新します。実行するには引数無しで再実行してください"
    [ -z "${UPTIMEROBOT_API_KEY:-}" ] && log "注意: API キー未設定のため、実行時は setup 手順が表示されます"
    exit 0
fi

log "完了: 作成 ${CREATED}件 / 更新 ${UPDATED}件"
if [ -z "$UPTIMEROBOT_ALERT_CONTACT_ID" ]; then
    log "注意: UPTIMEROBOT_ALERT_CONTACT_ID 未設定。ダッシュボードで通知先を紐付けてください（さもないと落ちても通知されません）"
fi
exit 0
