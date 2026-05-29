#!/usr/bin/env bash
# monitor-claude-health.sh - 24h ループヘルスチェック (5軸)
#
# 軸A: OAuth fail (~/.claude/daemon-auth-status.json が auth_required) → critical
# 軸B: claude --version 差分監視 (--prompt-file 級 breaking change 検出) → warning
# 軸C: lane-*.log 0byte 連続 (罠3/5/6 兆候、過去1h以内 created で size=0) → warning/critical
# 軸D: dispatch idle (agents 空 + pending>0) → critical
# 軸E: session_id 未取得 (state=running で 60s 以上 session_id=NULL、罠5/6 兆候) → warning/critical
#
# 通知先: Slack #rajiuce-dev (C0AG07HFJTB)、6h throttle
# launchd plist: SCRIPTS/launchd/com.r2c.monitor.plist (StartInterval=300)
# 詳細: docs/postmortem/2026-05-28-oauth-fail/MONITOR_TASK.md

set -uo pipefail

R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${R2C_ROOT}/.claude/queue/r2c-queue.db"
LOG_DIR="${R2C_CONFIG}/logs"
STATE_DIR="${R2C_CONFIG}/state"
THROTTLE_FILE="${STATE_DIR}/monitor-throttle.json"
VERSION_FILE="${STATE_DIR}/last-claude-version.txt"
THROTTLE_SECONDS=21600   # 6h

mkdir -p "$LOG_DIR" "$STATE_DIR"

# env load (secrets/Slack token 等)
# shellcheck disable=SC1091
source "${R2C_CONFIG}/secrets/r2c-loop.env" 2>/dev/null || true

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ts() { date +'%Y-%m-%dT%H:%M:%S%z'; }
epoch() { date +%s; }

# throttle (axis × severity に 6h 抑止、復旧通知は throttle 対象外)
throttle_ok() {
    local key="$1"  # e.g. "A:critical"
    local now last
    now=$(epoch)
    if [ ! -f "$THROTTLE_FILE" ]; then
        echo "{}" > "$THROTTLE_FILE"
    fi
    last=$(jq -r --arg k "$key" '.[$k] // 0' "$THROTTLE_FILE" 2>/dev/null || echo 0)
    if [ -z "$last" ] || ! [[ "$last" =~ ^[0-9]+$ ]]; then
        last=0
    fi
    if [ "$((now - last))" -ge "$THROTTLE_SECONDS" ]; then
        return 0
    fi
    return 1
}

throttle_record() {
    local key="$1"
    local now
    now=$(epoch)
    if [ ! -f "$THROTTLE_FILE" ]; then
        echo "{}" > "$THROTTLE_FILE"
    fi
    local tmp
    tmp=$(mktemp)
    jq --arg k "$key" --argjson v "$now" '.[$k] = $v' "$THROTTLE_FILE" > "$tmp" && mv "$tmp" "$THROTTLE_FILE"
}

# Slack 通知 (簡易、curl + chat.postMessage)
notify() {
    local severity="$1"  # critical|warning|recovery
    local axis="$2"      # A|B|C|D|E
    local title="$3"
    local detail="$4"
    local key="${axis}:${severity}"
    local emoji
    case "$severity" in
        critical)  emoji=":rotating_light:" ;;
        warning)   emoji=":warning:" ;;
        recovery)  emoji=":white_check_mark:" ;;
        *)         emoji=":bell:" ;;
    esac
    local msg="${emoji} *[monitor-claude-health 軸${axis} ${severity}]* ${title}\n${detail}"
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[$(ts)] DRY-RUN notify ${key}: ${title}"
        echo "  detail: ${detail}"
        return 0
    fi
    # recovery は throttle 対象外
    if [ "$severity" != "recovery" ]; then
        if ! throttle_ok "$key"; then
            echo "[$(ts)] throttled ${key}: ${title}"
            return 0
        fi
    fi
    if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_CHANNEL_ID:-}" ]; then
        echo "[$(ts)] WARN: SLACK_BOT_TOKEN/SLACK_CHANNEL_ID 未配備、stderr のみ" >&2
        echo "  ${msg}" >&2
        return 0
    fi
    curl -s -X POST https://slack.com/api/chat.postMessage \
        -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
        -H "Content-Type: application/json; charset=utf-8" \
        -d "$(jq -n --arg ch "${SLACK_CHANNEL_ID}" --arg t "${msg}" '{channel:$ch, text:$t}')" \
        >/dev/null 2>&1 || true
    throttle_record "$key"
    echo "[$(ts)] notified ${key}: ${title}"
}

# 軸A: OAuth fail
check_axis_a() {
    local status_file="$HOME/.claude/daemon-auth-status.json"
    local cooldown_file="$HOME/.claude/daemon-auth-cooldown"
    local recovery_marker="${STATE_DIR}/.axis_a_alerted"
    if [ -f "$status_file" ]; then
        local status
        status=$(jq -r '.status // "unknown"' "$status_file" 2>/dev/null || echo unknown)
        if [ "$status" = "auth_required" ]; then
            notify critical A "OAuth daemon 凍結 (auth_required)" "復旧手順: hkobayashi 手動で \`claude /login\` 実行。詳細: docs/postmortem/2026-05-28-oauth-fail/MEMORY_27.md"
            touch "$recovery_marker"
            return
        fi
    fi
    if [ -f "$cooldown_file" ]; then
        notify critical A "OAuth daemon cooldown ファイル存在" "$cooldown_file が存在。daemon が auth 再試行待ち。"
        touch "$recovery_marker"
        return
    fi
    # 復旧通知
    if [ -f "$recovery_marker" ]; then
        notify recovery A "OAuth 復旧確認" "daemon-auth-status.json および cooldown が消失、valid 状態に戻った。"
        rm -f "$recovery_marker"
    fi
}

# 軸B: claude --version 差分
check_axis_b() {
    local current
    current=$(claude --version 2>/dev/null | head -1 || echo unknown)
    if [ -z "$current" ] || [ "$current" = "unknown" ]; then
        return
    fi
    if [ ! -f "$VERSION_FILE" ]; then
        echo "$current" > "$VERSION_FILE"
        return
    fi
    local previous
    previous=$(cat "$VERSION_FILE")
    if [ "$current" != "$previous" ]; then
        notify warning B "claude --version 変化検出" "${previous} → ${current}。罠2 級 breaking change 再発の可能性、24h ループ e2e 確認推奨。"
        echo "$current" > "$VERSION_FILE"
    fi
}

# 軸C: lane-*.log 0byte 連続
check_axis_c() {
    local count
    count=$(find "$LOG_DIR" -name "lane-*.log" -size 0c -mmin -60 2>/dev/null | wc -l | tr -d ' ')
    if [ "$count" -ge 5 ]; then
        notify critical C "lane-*.log 0byte 多発" "過去1hで ${count} 件。罠2/3/5/6 のいずれかが再発の疑い。"
    elif [ "$count" -ge 2 ]; then
        notify warning C "lane-*.log 0byte 連続" "過去1hで ${count} 件 (1件なら短prompt正常exit可能性、2件以上は要調査)。"
    fi
}

# 軸D: dispatch idle (agents 空 + pending>0)
check_axis_d() {
    [ -f "$QUEUE_DB" ] || return
    local pending agent_count
    pending=$(sqlite3 "$QUEUE_DB" "SELECT COUNT(*) FROM tasks WHERE state='prompt_generated';" 2>/dev/null || echo 0)
    agent_count=$(claude agents --json 2>/dev/null | jq -r 'length' 2>/dev/null || echo 0)
    if [ -z "$pending" ] || ! [[ "$pending" =~ ^[0-9]+$ ]]; then pending=0; fi
    if [ -z "$agent_count" ] || ! [[ "$agent_count" =~ ^[0-9]+$ ]]; then agent_count=0; fi
    if [ "$agent_count" -eq 0 ] && [ "$pending" -gt 0 ]; then
        notify critical D "dispatch idle (pending滞留)" "agents=0 / pending=${pending}。launchd cron が拾えていない可能性。"
    fi
}

# 軸E: state=running で session_id NULL が 60s 以上 (罠5/6 兆候)
check_axis_e() {
    [ -f "$QUEUE_DB" ] || return
    local count
    count=$(sqlite3 "$QUEUE_DB" "SELECT COUNT(*) FROM tasks WHERE state='running' AND (session_id IS NULL OR session_id='') AND started_at < datetime('now', '-60 seconds');" 2>/dev/null || echo 0)
    if [ -z "$count" ] || ! [[ "$count" =~ ^[0-9]+$ ]]; then count=0; fi
    if [ "$count" -ge 3 ]; then
        notify critical E "session_id 未取得多発 (罠5/6 兆候)" "running task が ${count} 件 session_id NULL のまま 60s 超。cron context spawn 不能の可能性。"
    elif [ "$count" -ge 1 ]; then
        notify warning E "session_id 未取得検出" "running task が ${count} 件 session_id NULL のまま 60s 超。resolver 動作確認推奨。"
    fi
}

echo "[$(ts)] monitor-claude-health start (dry_run=${DRY_RUN})"
check_axis_a
check_axis_b
check_axis_c
check_axis_d
check_axis_e
echo "[$(ts)] monitor-claude-health end"
exit 0
