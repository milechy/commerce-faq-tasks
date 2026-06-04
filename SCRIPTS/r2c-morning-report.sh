#!/usr/bin/env bash
# r2c-morning-report.sh — R2C 24h ループ朝 06:00 cron レポート
#
# 用途:
#   docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md §4 の Slack Block Kit JSON
#   を構造化生成して `#r2c` (C0AG07HFJTB) に投稿、Pushover priority -2 で
#   iOS にも軽通知する。
#
# 環境変数:
#   R2C_ROOT, R2C_CONFIG, QUEUE_DB, LOG_DIR
#   ASANA_PROJECT_GID (bake-in: 1213607637045514)
#
# 呼び出し例:
#   r2c-morning-report.sh             # 通常実行 (Slack + Pushover)
#   r2c-morning-report.sh --dry-run   # Block Kit JSON を stdout 出力、送信なし
set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
LOG_DIR="${R2C_CONFIG}/logs"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"

ASANA_PROJECT_GID="1213607637045514"
SLACK_CHANNEL_ID="C0AG07HFJTB"
SLACK_NOTIFY_BIN="${R2C_ROOT}/SCRIPTS/r2c-slack-notify.sh"
PUSHOVER_BIN="${R2C_ROOT}/SCRIPTS/r2c-pushover.sh"
CODEX_AGG_BIN="${R2C_ROOT}/SCRIPTS/r2c-codex-aggregator.sh"

DRY_RUN=0

usage() { echo "Usage: r2c-morning-report.sh [--dry-run]"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 1; }

mkdir -p "$LOG_DIR"
if [[ "$DRY_RUN" -eq 0 ]]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >&2; }

DATE_STR="$(date '+%Y-%m-%d')"
NOW_JST="$(date '+%Y-%m-%d %H:%M JST')"
NEXT_JST="$(date -v+1d '+%Y-%m-%d 06:00 JST' 2>/dev/null \
    || date -d 'tomorrow' '+%Y-%m-%d 06:00 JST' 2>/dev/null \
    || echo "翌日 06:00 JST")"

# ─── queue helper (graceful) ───
sq() {
    if command -v sqlite3 >/dev/null 2>&1 && [[ -r "$QUEUE_DB" ]]; then
        sqlite3 -separator '|' "$QUEUE_DB" "$1" 2>/dev/null || true
    fi
}

# ─── L1: /health 7d 稼働率 ───
# TODO(Phase 4): Prometheus query `up{job="api"}` の 7 日平均に置換
#   暫定: api.r2c.biz/health を 1 回 curl して 200 なら 100%、それ以外 N/A
_get_health_uptime_7d() {
    local code
    code="$(curl -fsS --max-time 10 -o /dev/null -w "%{http_code}" \
        https://api.r2c.biz/health 2>/dev/null || echo "fail")"
    if [[ "$code" == "200" ]]; then
        echo "100% (snapshot)"
    else
        echo "N/A (snapshot=${code})"
    fi
}

# ─── L2: PM2 再起動回数 24h ───
# TODO(Phase 4): VPS から pm2 jlist を取得し restart_time 差分集計
#   暫定: deploy_guard が ssh を遮断するため固定値 0
_get_pm2_restart_24h() {
    echo "0 (TODO Phase 4)"
}

# ─── L3: Codex Gate 2.5 通過率 7d ───
_get_codex_pass_rate_7d() {
    local total passed
    total="$(sq "SELECT COUNT(*) FROM tasks \
        WHERE gate_2_5_required = 1 \
          AND created_at > datetime('now','-7 days');")"
    passed="$(sq "SELECT COUNT(*) FROM tasks \
        WHERE gate_2_5_required = 1 \
          AND state IN ('merged','done','deployed') \
          AND updated_at > datetime('now','-7 days');")"
    total="${total:-0}"
    passed="${passed:-0}"
    if [[ "$total" -eq 0 ]]; then
        echo "N/A (0 件)"
    else
        local pct=$(( passed * 100 / total ))
        echo "${pct}% (${passed}/${total})"
    fi
}

# ─── L4: Asana 期限遵守率 ───
# TODO(Phase 4): Asana MCP get_tasks_for_project で due_on vs completed_at 算出
_get_asana_due_compliance() {
    echo "85% (TODO Phase 4)"
}

# ─── L5: Admin UI ログイン成功率 24h ───
# TODO(Phase 4): /v1/admin/auth/login のメトリクスから算出
_get_admin_ui_login_24h() {
    echo "100% (TODO Phase 4)"
}

# ─── L6: Tier 2 通知件数 7d ───
# TODO(Phase 4): notify-log.json から priority=2 件数集計
_get_tier2_notify_count_7d() {
    echo "0 (TODO Phase 4)"
}

# ─── 承認待ち Tier S / Tier A ───
_get_pending_tier_s_a() {
    local tier="$1"
    local state
    if [[ "$tier" == "S" ]]; then
        state="needs_approval_critical"
    else
        state="needs_approval"
    fi
    sq "SELECT asana_gid, asana_name FROM tasks \
        WHERE state = '${state}' AND tier = '${tier}' \
        ORDER BY created_at ASC LIMIT 10;"
}

# ─── Lane 失敗 (24h) ───
_get_lane_failures_24h() {
    sq "SELECT id, COALESCE(pr_number, 0) AS prn, asana_name FROM tasks \
        WHERE state = 'failed' \
          AND COALESCE(completed_at, updated_at) > datetime('now','-1 day') \
        ORDER BY updated_at DESC LIMIT 10;"
}

# ─── テスト自動化統計 (test-seeder 由来タスク) ───
_get_test_seeder_stats() {
    local queued_24h done_24h pending total_seeded
    queued_24h="$(sq "SELECT COUNT(*) FROM tasks \
        WHERE task_type = 'test' \
          AND created_at > datetime('now','-1 day');")"
    done_24h="$(sq "SELECT COUNT(*) FROM tasks \
        WHERE task_type = 'test' \
          AND state IN ('merged','done','deployed') \
          AND updated_at > datetime('now','-1 day');")"
    pending="$(sq "SELECT COUNT(*) FROM tasks \
        WHERE task_type = 'test' \
          AND state IN ('pending','prompt_generated','running','pr_created','verify_passed','ready_to_merge');")"
    total_seeded="$(sq "SELECT COUNT(*) FROM tasks WHERE task_type = 'test';")"
    queued_24h="${queued_24h:-0}"
    done_24h="${done_24h:-0}"
    pending="${pending:-0}"
    total_seeded="${total_seeded:-0}"
    printf '%s|%s|%s|%s' "$queued_24h" "$done_24h" "$pending" "$total_seeded"
}

# ─── Render Tier list as bullet lines for Slack mrkdwn ───
_render_tier_lines() {
    local rows="$1" label="$2"
    local count=0
    local lines=""
    if [[ -n "$rows" ]]; then
        while IFS='|' read -r gid name; do
            [[ -z "$gid" ]] && continue
            count=$((count + 1))
            local short
            short="$(printf '%s' "$name" | cut -c1-40)"
            local url="https://app.asana.com/0/${ASANA_PROJECT_GID}/${gid}"
            lines+="• <${url}|${short}>"$'\n'
        done <<< "$rows"
    fi
    if [[ "$count" -eq 0 ]]; then
        printf '*%s*: 0 件' "$label"
    else
        printf '*%s*: %d 件\n%s' "$label" "$count" "${lines%$'\n'}"
    fi
}

_render_lane_failures() {
    local rows="$1"
    local count=0
    local lines=""
    if [[ -n "$rows" ]]; then
        while IFS='|' read -r task_id prn name; do
            [[ -z "$task_id" ]] && continue
            count=$((count + 1))
            local short
            short="$(printf '%s' "$name" | cut -c1-40)"
            if [[ "${prn:-0}" != "0" ]]; then
                lines+="• PR #${prn} ${short}"$'\n'
            else
                lines+="• task ${task_id} ${short}"$'\n'
            fi
        done <<< "$rows"
    fi
    printf '%d|%s' "$count" "${lines%$'\n'}"
}

# ─── Gather metrics ───
log "=== Morning Report Start (${DATE_STR}) ==="

L1="$(_get_health_uptime_7d)"
L2="$(_get_pm2_restart_24h)"
L3="$(_get_codex_pass_rate_7d)"
L4="$(_get_asana_due_compliance)"
L5="$(_get_admin_ui_login_24h)"
L6="$(_get_tier2_notify_count_7d)"

TIER_S_ROWS="$(_get_pending_tier_s_a S)"
TIER_A_ROWS="$(_get_pending_tier_s_a A)"
TIER_S_FIELD="$(_render_tier_lines "$TIER_S_ROWS" "Tier S")"
TIER_A_FIELD="$(_render_tier_lines "$TIER_A_ROWS" "Tier A")"

FAIL_RAW="$(_get_lane_failures_24h)"
FAIL_RENDER="$(_render_lane_failures "$FAIL_RAW")"
FAIL_COUNT="${FAIL_RENDER%%|*}"
FAIL_LINES="${FAIL_RENDER#*|}"
[[ -z "$FAIL_LINES" || "$FAIL_LINES" == "$FAIL_RENDER" ]] && FAIL_LINES="(なし)"

TEST_STATS_RAW="$(_get_test_seeder_stats)"
TEST_QUEUED_24H="${TEST_STATS_RAW%%|*}"
_rest="${TEST_STATS_RAW#*|}"
TEST_DONE_24H="${_rest%%|*}"
_rest="${_rest#*|}"
TEST_PENDING="${_rest%%|*}"
TEST_TOTAL="${_rest#*|}"
TEST_SUMMARY="追加 ${TEST_QUEUED_24H} 件 / 完了 ${TEST_DONE_24H} 件 / 未着手 ${TEST_PENDING} 件 (累計 ${TEST_TOTAL} 件)"

# ─── Codex aggregator (Block Kit 部分 JSON) ───
CODEX_BLOCKS="[]"
if [[ -x "$CODEX_AGG_BIN" ]]; then
    CODEX_BLOCKS="$("$CODEX_AGG_BIN" --output-block 2>/dev/null || echo '[]')"
fi
# fallback
echo "$CODEX_BLOCKS" | jq empty >/dev/null 2>&1 || CODEX_BLOCKS="[]"

# ─── Build Block Kit JSON ───
TIER_PENDING_S_COUNT=0
TIER_PENDING_A_COUNT=0
[[ -n "$TIER_S_ROWS" ]] && TIER_PENDING_S_COUNT=$(printf '%s\n' "$TIER_S_ROWS" | grep -c '^.' || true)
[[ -n "$TIER_A_ROWS" ]] && TIER_PENDING_A_COUNT=$(printf '%s\n' "$TIER_A_ROWS" | grep -c '^.' || true)

build_blocks() {
    local include_approval=1 include_failures=1
    if [[ "$TIER_PENDING_S_COUNT" -eq 0 && "$TIER_PENDING_A_COUNT" -eq 0 ]]; then
        include_approval=0
    fi
    if [[ "$FAIL_COUNT" -eq 0 ]]; then
        include_failures=0
    fi

    jq -nc \
        --arg date "$DATE_STR" \
        --arg L1 "$L1" --arg L2 "$L2" --arg L3 "$L3" \
        --arg L4 "$L4" --arg L5 "$L5" --arg L6 "$L6" \
        --arg tier_s "$TIER_S_FIELD" \
        --arg tier_a "$TIER_A_FIELD" \
        --arg fail_lines "$FAIL_LINES" \
        --arg test_summary "$TEST_SUMMARY" \
        --arg now "$NOW_JST" --arg next "$NEXT_JST" \
        --argjson include_approval "$include_approval" \
        --argjson include_failures "$include_failures" \
        --argjson codex_blocks "$CODEX_BLOCKS" \
        '{
          blocks: (
            [
              { type: "header",
                text: { type: "plain_text", text: ("🌅 R2C Morning Report — " + $date) } },
              { type: "section",
                fields: [
                  { type: "mrkdwn", text: ("*L1 /health 稼働率 (7d)*: " + $L1) },
                  { type: "mrkdwn", text: ("*L2 PM2 再起動 (24h)*: " + $L2) },
                  { type: "mrkdwn", text: ("*L3 Codex Gate 2.5 通過率 (7d)*: " + $L3) },
                  { type: "mrkdwn", text: ("*L4 Asana 期限遵守率*: " + $L4) },
                  { type: "mrkdwn", text: ("*L5 Admin UI ログイン (24h)*: " + $L5) },
                  { type: "mrkdwn", text: ("*L6 Tier 2 通知 (7d)*: " + $L6) }
                ]
              },
              { type: "divider" }
            ]
            +
            ( if $include_approval == 1 then
                [ { type: "section",
                    text: { type: "mrkdwn", text: "*📋 承認待ち*" } },
                  { type: "section",
                    fields: [
                      { type: "mrkdwn", text: $tier_s },
                      { type: "mrkdwn", text: $tier_a }
                    ] },
                  { type: "divider" } ]
              else
                [ { type: "section",
                    text: { type: "mrkdwn", text: "*✅ 承認待ち: 0 件*" } },
                  { type: "divider" } ]
              end )
            +
            $codex_blocks
            +
            [ { type: "divider" },
              { type: "section",
                text: { type: "mrkdwn",
                        text: ("*🧪 テスト自動化 (24h)*: " + $test_summary) } },
              { type: "divider" } ]
            +
            ( if $include_failures == 1 then
                [ { type: "section",
                    text: { type: "mrkdwn", text: "*🚧 Lane 失敗 (24h)*" } },
                  { type: "section",
                    text: { type: "mrkdwn", text: $fail_lines } } ]
              else
                [] end )
            +
            [ { type: "context",
                elements: [
                  { type: "mrkdwn",
                    text: ("生成: " + $now + " | 次回: " + $next + " | source: `SCRIPTS/r2c-morning-report.sh`") }
                ] } ]
          )
        }'
}

BLOCK_JSON="$(build_blocks)"

# ─── Dry-run: print and exit ───
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%s\n' "$BLOCK_JSON" | jq .
    exit 0
fi

# ─── Slack 投稿 ───
TMP_JSON="$(mktemp -t r2c-morning-XXXXXX.json)"
trap 'rm -f "$TMP_JSON"' EXIT
printf '%s' "$BLOCK_JSON" > "$TMP_JSON"

if [[ -x "$SLACK_NOTIFY_BIN" ]]; then
    "$SLACK_NOTIFY_BIN" --block-kit "$TMP_JSON" --channel "$SLACK_CHANNEL_ID" \
        || log "WARN: Slack post failed"
else
    log "ERROR: $SLACK_NOTIFY_BIN not executable"
fi

# ─── Pushover priority -2 (Lowest) ───
if [[ -x "$PUSHOVER_BIN" ]]; then
    SUMMARY="朝報 ${DATE_STR}: S=${TIER_PENDING_S_COUNT} A=${TIER_PENDING_A_COUNT} fail=${FAIL_COUNT}"
    "$PUSHOVER_BIN" --priority -2 --summary "$SUMMARY" \
        || log "WARN: Pushover (-2) failed"
fi

log "=== Morning Report Done (${DATE_STR}) ==="
