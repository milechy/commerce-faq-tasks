#!/usr/bin/env bash
# check-pm2-health.sh — PM2 プロセス健全性チェック + escalation 連携
# Phase70 設計判断 Q3 (Asana 1214955296965915)
#
# 用途:
#   ローカル or VPS 上で `pm2 jlist` を JSON parse し、各プロセスの
#   restart_time を閾値判定 → 警告/escalation を notify-slack.sh 経由で投稿。
#
# 設計判断 Q3 (docs/R2C_DEVELOPMENT_PLAYBOOK.md "Escalation" 章参照):
#   - restart_time > WARN_THRESHOLD  (既定 50) → alert_type=pm2_restart で通常alert
#       → notify-slack.sh の counter が 5 連続で escalation 発火 (Q2 と整合)
#   - restart_time > EMERGENCY_THRESHOLD (既定 100) → --immediate-escalation
#       → counter 経由せず即時 escalation 投稿
#
# 使い方:
#   bash SCRIPTS/check-pm2-health.sh                        # 通常実行
#   bash SCRIPTS/check-pm2-health.sh --dry-run              # notify-slack.sh は dry-run 動作
#   bash SCRIPTS/check-pm2-health.sh --warn 30 --emergency 80
#   bash SCRIPTS/check-pm2-health.sh --self-test            # mock fixture で動作確認
#
# 環境変数:
#   PM2_JLIST_CMD   — `pm2 jlist` を別コマンドで上書き (テスト用、例: cat fixture.json)
#   ALERT_DB_PATH   — notify-slack.sh と共有する alert DB path
#   NOTIFY_SCRIPT   — notify-slack.sh のパス (default: <repo>/SCRIPTS/notify-slack.sh)
#
# 注意:
#   - 本スクリプトはローカル参照のみ。VPS 接続 (ssh root@) は含めない
#     (deploy_guard.py が block するため + 24h 自走中 Out of scope)
#   - 本番 VPS での実行は hkobayashi が手動 deploy 後に launchd / cron 5min で登録
#   - jq 必須。無い場合は exit 1 (CI でも fail させる)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

NOTIFY_SCRIPT="${NOTIFY_SCRIPT:-${SCRIPT_DIR}/notify-slack.sh}"
PM2_JLIST_CMD="${PM2_JLIST_CMD:-pm2 jlist}"
WARN_THRESHOLD=50
EMERGENCY_THRESHOLD=100
DRY_RUN=0
SELF_TEST=0

usage() {
    cat <<'USAGE'
Usage: check-pm2-health.sh [--warn N] [--emergency N] [--dry-run] [--self-test]

Thresholds:
  --warn N       restart_time が N 超で通常alert (default 50)
  --emergency N  restart_time が N 超で即時escalation (default 100)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --warn)      WARN_THRESHOLD="${2:-50}"; shift 2 ;;
        --emergency) EMERGENCY_THRESHOLD="${2:-100}"; shift 2 ;;
        --dry-run)   DRY_RUN=1; shift ;;
        --self-test) SELF_TEST=1; shift ;;
        -h|--help)   usage; exit 0 ;;
        *)           echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq required but not installed" >&2
    exit 1
fi

# ─── self-test: fixture で動作検証 (notify-slack.sh は dry-run) ───
if [[ "$SELF_TEST" -eq 1 ]]; then
    # 4プロセス: 健全(restart=0) / warn(restart=55) / warn(restart=80) / emergency(restart=120)
    TMP_FIXTURE="$(mktemp)"
    cat > "$TMP_FIXTURE" <<'JSON'
[
  {"name":"healthy-process","pm_id":0,"pm2_env":{"restart_time":0,"status":"online"}},
  {"name":"warn-process-a","pm_id":1,"pm2_env":{"restart_time":55,"status":"online"}},
  {"name":"warn-process-b","pm_id":2,"pm2_env":{"restart_time":80,"status":"online"}},
  {"name":"emergency-process","pm_id":3,"pm2_env":{"restart_time":120,"status":"online"}}
]
JSON
    echo "[self-test] fixture: $TMP_FIXTURE"
    PM2_JLIST_CMD="cat $TMP_FIXTURE" DRY_RUN=1 \
        "$0" --dry-run --warn 50 --emergency 100
    rc=$?
    rm -f "$TMP_FIXTURE"
    [[ "$rc" -eq 0 ]] && echo "[self-test] PASS" || echo "[self-test] FAIL (rc=$rc)"
    exit "$rc"
fi

# ─── 本処理 ───
if ! command -v "$(echo "$PM2_JLIST_CMD" | awk '{print $1}')" >/dev/null 2>&1; then
    echo "ERROR: PM2_JLIST_CMD '$PM2_JLIST_CMD' first token not executable" >&2
    exit 1
fi

# pm2 jlist (or override) は stderr 混入が多いので 2>/dev/null で抑制
JLIST_JSON="$($PM2_JLIST_CMD 2>/dev/null || true)"
if [[ -z "$JLIST_JSON" ]]; then
    echo "ERROR: pm2 jlist returned empty output" >&2
    exit 1
fi

# 妥当性チェック (jq parse error なら ERROR)
if ! echo "$JLIST_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "ERROR: pm2 jlist output is not a JSON array" >&2
    exit 1
fi

# 各プロセスを走査、しきい値判定
ALERT_TOTAL=0
EMERGENCY_TOTAL=0
WARN_TOTAL=0

# jq で name と restart_time を tab 区切りで出力
while IFS=$'\t' read -r pname restart; do
    [[ -z "$pname" ]] && continue
    # 数値以外は skip
    if ! [[ "$restart" =~ ^[0-9]+$ ]]; then
        continue
    fi
    if [[ "$restart" -gt "$EMERGENCY_THRESHOLD" ]]; then
        MSG="[PM2-EMERGENCY] ${pname}: restart_time=${restart} (threshold=${EMERGENCY_THRESHOLD})"
        EMERGENCY_TOTAL=$((EMERGENCY_TOTAL + 1))
        ALERT_TOTAL=$((ALERT_TOTAL + 1))
        echo "$MSG"
        EXTRA_FLAGS=()
        [[ "$DRY_RUN" -eq 1 ]] && EXTRA_FLAGS+=(--dry-run)
        bash "$NOTIFY_SCRIPT" "$MSG" \
            --color error \
            --alert-type pm2_restart \
            --immediate-escalation \
            "${EXTRA_FLAGS[@]}" || true
    elif [[ "$restart" -gt "$WARN_THRESHOLD" ]]; then
        MSG="[PM2] ${pname}: restart_time=${restart} (warn>${WARN_THRESHOLD})"
        WARN_TOTAL=$((WARN_TOTAL + 1))
        ALERT_TOTAL=$((ALERT_TOTAL + 1))
        echo "$MSG"
        EXTRA_FLAGS=()
        [[ "$DRY_RUN" -eq 1 ]] && EXTRA_FLAGS+=(--dry-run)
        bash "$NOTIFY_SCRIPT" "$MSG" \
            --color warning \
            --alert-type pm2_restart \
            "${EXTRA_FLAGS[@]}" || true
    fi
done < <(echo "$JLIST_JSON" | jq -r '.[] | [.name, (.pm2_env.restart_time // 0)] | @tsv')

echo "[check-pm2-health] total alerts=${ALERT_TOTAL} (warn=${WARN_TOTAL}, emergency=${EMERGENCY_TOTAL})"
exit 0
