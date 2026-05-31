#!/usr/bin/env bash
# r2c-dispatch.sh
# 用途: prompt_generated 状態のタスクを Lane (claude --bg) に dispatch する。
#       --auto モード (cron) は空き slot に Tier 優先で投入。
#       night mode 中は Tier S/A を投入しない。
# Cron 間隔: */1 * * * *  (--auto)
# 必要環境変数:
#   ${R2C_CONFIG}/secrets/r2c-loop.env から読込 (Asana token 等は使わないが PATH 系を継承)
# 呼び出し例:
#   bash SCRIPTS/r2c-dispatch.sh --auto
#   bash SCRIPTS/r2c-dispatch.sh --task-id 42
#   bash SCRIPTS/r2c-dispatch.sh --auto --dry-run
#
# Phase 1 Step E-A — docs/24H_AUTOMATION_RUNBOOK_R2C.md 参照。

set -euo pipefail

# ─── R2C 定数 ─────────────────────────────────────────────────────────────
R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${R2C_ROOT}/.claude/queue/r2c-queue.db"
WORKTREE_BASE="${R2C_ROOT}/.claude/worktrees"
LOG_DIR="${R2C_CONFIG}/logs"
SCRIPT_NAME="$(basename "$0" .sh)"
# UATa 3日運用教訓: 同時稼働 Lane が 3本を超えると Claude Code の result drop /
# context 断絶が多発した (公式 issue #39830 と一致, 実測 154件)。同時上限を 3 に抑制。
# 並列 tool call も 3本未満に保つこと (CLAUDE.md「24h ループ並列上限」参照)。
MAX_SLOTS=3

# ─── 引数 ──────────────────────────────────────────────────────────────────
TASK_ID=""
AUTO_MODE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --task-id) TASK_ID="$2"; shift 2 ;;
        --auto)    AUTO_MODE=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [ -z "$TASK_ID" ] && [ "$AUTO_MODE" -eq 0 ]; then
    echo "Usage: $0 --task-id <id> | --auto [--dry-run]" >&2
    exit 1
fi

mkdir -p "$LOG_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

# secrets fail-fast: 24h ループ本体は secrets 必須。silent-failure で空 token のまま
# Lane を起動すると通知不能の連鎖事故になるため、未配備/source 失敗時は即停止する。
# (注: Slack 認証情報も secrets 内のため、未配備時の通知は stderr 止まりになる)
SECRETS_FILE="${R2C_CONFIG}/secrets/r2c-loop.env"
if [ ! -f "$SECRETS_FILE" ]; then
    echo "[$(date +%Y-%m-%d_%H:%M:%S)] FATAL: secrets not found: ${SECRETS_FILE} — 配備後に再実行" >&2
    bash "${R2C_ROOT}/SCRIPTS/notify-slack.sh" "🛑 r2c-dispatch: secrets 未配備で起動中止 (${SECRETS_FILE})" --color error 2>/dev/null || true
    exit 1
fi
# shellcheck disable=SC1090,SC1091
source "$SECRETS_FILE" || {
    echo "[$(date +%Y-%m-%d_%H:%M:%S)] FATAL: failed to source secrets: ${SECRETS_FILE}" >&2
    exit 1
}

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-dispatch start (auto=${AUTO_MODE} task=${TASK_ID:-NA} dry=${DRY_RUN}) ==="

if [ ! -f "$QUEUE_DB" ]; then
    echo "ERROR: Queue DB not found: $QUEUE_DB" >&2
    exit 1
fi

# ─── ヘルパー ─────────────────────────────────────────────────────────────
SQ() { sqlite3 "$QUEUE_DB" "$1"; }

# ─── 自動 mode の前段チェック ────────────────────────────────────────────
CURRENT_MODE=$(SQ "SELECT value FROM automation_state WHERE key = 'mode';" || true)
PAUSE=$(SQ "SELECT value FROM automation_state WHERE key = 'pause_dispatching';" || true)

if [ "${PAUSE:-0}" = "1" ]; then
    if [ "$AUTO_MODE" -eq 1 ]; then
        exit 0
    fi
    echo "Dispatching is paused. Resume: sqlite3 ${QUEUE_DB} \"UPDATE automation_state SET value='0' WHERE key='pause_dispatching';\""
    exit 0
fi

ACTIVE_COUNT=$(SQ "SELECT COUNT(*) FROM tasks WHERE state = 'running';")
ACTIVE_COUNT=${ACTIVE_COUNT:-0}
AVAILABLE_SLOTS=$((MAX_SLOTS - ACTIVE_COUNT))

if [ "$AUTO_MODE" -eq 1 ] && [ "$AVAILABLE_SLOTS" -le 0 ]; then
    echo "No free slots (active=${ACTIVE_COUNT}/${MAX_SLOTS}), skipping cycle"
    exit 0
fi

# ─── auto mode: dispatch 候補抽出 ────────────────────────────────────────
NIGHT_FILTER=""
if [ "${CURRENT_MODE:-day}" = "night" ]; then
    NIGHT_FILTER="AND night_mode_allowed = 1 AND tier = 'B'"
fi

dispatch_one() {
    local task_id="$1"

    local task_data
    task_data=$(SQ "SELECT asana_gid, asana_name, tier, task_type, prompt_path, state, model FROM tasks WHERE id = ${task_id};") || true
    if [ -z "$task_data" ]; then
        echo "ERROR: Task ${task_id} not found"
        return 1
    fi

    local asana_gid name tier task_type prompt_path state model
    IFS='|' read -r asana_gid name tier task_type prompt_path state model <<< "$task_data"
    echo "  asana_gid=${asana_gid} tier=${tier} type=${task_type}"

    if [ "$state" != "prompt_generated" ]; then
        echo "ERROR: Task ${task_id} state='${state}', expected 'prompt_generated'"
        return 1
    fi

    if [ -z "$prompt_path" ] || [ ! -f "$prompt_path" ]; then
        echo "ERROR: prompt_path missing for task ${task_id}: ${prompt_path}"
        return 1
    fi

    local slug
    slug=$(echo "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
    [ -z "$slug" ] && slug="task"
    local worktree_path="${WORKTREE_BASE}/lane-${task_id}-${slug}"
    local branch_name="auto/${tier,,}-${task_id}-${slug}"
    local log_file="${LOG_DIR}/lane-${task_id}.log"
    local lane_name="auto-${tier,,}-${task_id}"
    # Tier B は夜間自律実行のため bypassPermissions（acceptEdits だと Bash で
    # permission prompt が固着し停止する）。.claude/settings.json の deny 層が
    # force/main push・scp・rm -rf /opt・.env/opt 書込みを最終防衛する前提。
    # Tier A/S は朝承認・人間判断のため plan のまま。
    local perm_mode="bypassPermissions"
    case "$tier" in
        A) perm_mode="plan" ;;
        S) perm_mode="plan" ;;
    esac
    local resolved_model="${model:-claude-sonnet-4-6}"

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "DRY-RUN: would dispatch task=${task_id} tier=${tier} type=${task_type}"
        echo "  worktree=${worktree_path}"
        echo "  branch=${branch_name}"
        echo "  model=${resolved_model} perm=${perm_mode}"
        echo "  prompt=${prompt_path}"
        return 0
    fi

    if [ ! -d "$worktree_path" ]; then
        (
            cd "$R2C_ROOT"
            git fetch origin main 2>&1 | tail -3 || true
            if git show-ref --verify --quiet "refs/heads/${branch_name}"; then
                git worktree add "$worktree_path" "$branch_name"
            else
                git worktree add -b "$branch_name" "$worktree_path" origin/main
            fi
        ) || {
            echo "ERROR: git worktree add failed for task ${task_id}"
            SQ "UPDATE tasks SET state='failed', error_message='worktree add failed', last_action='dispatch_abort' WHERE id = ${task_id};"
            return 1
        }
    fi

    SQ "UPDATE tasks SET state='running', worktree_path='${worktree_path}', branch='${branch_name}', started_at=datetime('now'), attempt_count=COALESCE(attempt_count,0)+1, last_action='dispatched' WHERE id = ${task_id};"

    mkdir -p "$(dirname "$log_file")"

    # claude-code v2.1.152 で --prompt-file フラグが silently 削除された対応。
    # 旧形式 `--prompt-file '${prompt_path}'` は unknown flag として無視され、
    # claude --bg は prompt 無しで idle 起動 → 45min stuck → rollback していた。
    # stdin pipe で渡す形式に変更 (claude --help: `claude [options] [command] [prompt]`)。
    #
    # export PATH=... は cron-wrapper.sh が既に Homebrew 含む PATH を設定済みで
    # 完全に冗長な上、bash -c 内に置くと cat | claude --bg の stdin pipe が
    # 切れて claude が prompt を受信せず idle 起動する問題が判明 (2026-05-28)。
    # よって本ブロック内では export PATH を行わない。
    # 詳細: docs/postmortem/2026-05-28-oauth-fail/
    nohup bash -c "
        cd '${worktree_path}'
        cat '${prompt_path}' | claude --bg --name '${lane_name}' \\
            --model '${resolved_model}' \\
            --permission-mode '${perm_mode}' > '${log_file}' 2>&1
    " > /dev/null 2>&1 &
    disown

    # PR #197 残存リスク② 解消: session_id を Lane 自己申告に依存せず
    # dispatch 側で claude agents --json から自動発見して DB へ書き戻す。
    # 2026-05-26 OAuth daemon 凍結事故 (docs/postmortem/2026-05-28-oauth-fail/)
    # の根本原因。失敗時も Lane の自走は妨げない (resolver は常に exit 0)。
    nohup bash "${R2C_ROOT}/SCRIPTS/r2c-lane-session-resolver.sh" \
        --task-id "${task_id}" \
        --lane-name "${lane_name}" \
        --log-file "${log_file}.sid" > /dev/null 2>&1 &
    disown

    # ─── spawn 失敗検出 + retry (Agent Teams 4th teammate 権限失敗対策) ────
    # 背景: 2026-05-18 Step E-D で 4 番目の teammate のみ Bash 権限が取得できず
    # Team Lead 代行実装になった事案への恒久対策。
    # issue #25037: teammates が lead の制限 tool access を継承する既知バグ。
    # docs: docs/AGENT_TEAMS_BASH_PERMISSION_BUG.md
    #
    # 失敗判定: dispatch から 60 秒後に log_file が以下のいずれかなら spawn 失敗:
    #   (a) 0 バイト (claude が全く起動していない)
    #   (b) "(idle — send a prompt to start)" バナーのみ (prompt 未受信)
    #   (c) "auth_required" / "auth failed" を含む (OAuth 凍結)
    #
    # retry 上限: DB の attempt_count を参照し 3 回連続失敗で通知 + failed 遷移。
    # MAX_SLOTS を超える再 dispatch を防ぐため、retry 前に running 件数を再確認する。
    #
    # 注意: spawn checker は nohup + disown で非同期起動する。
    # dispatch_one の return 0 はすでに state='running' に遷移済みのため、
    # checker が失敗判定した場合に限り state を running→prompt_generated (retry) /
    # failed (上限超過) へ戻す。
    local attempt_count
    attempt_count=$(SQ "SELECT COALESCE(attempt_count,0) FROM tasks WHERE id = ${task_id};")
    attempt_count=${attempt_count:-0}

    nohup bash -c "
        sleep 60
        log='${log_file}'
        task_id='${task_id}'
        lane_name='${lane_name}'
        r2c_root='${R2C_ROOT}'
        queue_db='${QUEUE_DB}'
        max_slots='${MAX_SLOTS}'
        prompt_path='${prompt_path}'
        attempt_count='${attempt_count}'

        sq() { sqlite3 \"\$queue_db\" \"\$1\"; }

        # spawn 失敗判定
        spawn_failed=0
        if [ ! -s \"\$log\" ]; then
            spawn_failed=1
            reason='log 0 byte'
        elif grep -q '(idle — send a prompt to start)' \"\$log\" 2>/dev/null && ! grep -qv '(idle — send a prompt to start)' \"\$log\" 2>/dev/null; then
            spawn_failed=1
            reason='idle banner only'
        elif grep -qE 'auth_required|auth failed|Authentication required' \"\$log\" 2>/dev/null; then
            spawn_failed=1
            reason='auth failure'
        fi

        if [ \"\$spawn_failed\" -eq 0 ]; then
            exit 0
        fi

        echo \"[\$(date +%Y-%m-%d_%H:%M:%S)] SPAWN-CHECK: task \${task_id} spawn failed (reason=\${reason}, attempt=\${attempt_count})\"

        # 3 回連続失敗 → Slack 通知 + failed 遷移
        if [ \"\${attempt_count}\" -ge 3 ]; then
            echo \"[\$(date +%Y-%m-%d_%H:%M:%S)] SPAWN-CHECK: task \${task_id} 3回連続 spawn 失敗 → failed (degraded 3-slot 継続)\"
            sq \"UPDATE tasks SET state='failed', error_message='spawn failed 3 times: \${reason}', last_action='spawn_fail_final' WHERE id = \${task_id} AND state = 'running';\"
            bash \"\${r2c_root}/SCRIPTS/r2c-slack-notify.sh\" \\
                --text \"⚠️ R2C spawn 失敗 3 回連続: task \${task_id} (lane=\${lane_name}). 理由=\${reason}. 3-slot degraded 継続。docs/AGENT_TEAMS_BASH_PERMISSION_BUG.md 参照\" 2>/dev/null || true
            exit 1
        fi

        # retry 可否チェック: running 件数が MAX_SLOTS 未満か確認
        active=\$(sq \"SELECT COUNT(*) FROM tasks WHERE state = 'running';\")
        active=\${active:-0}
        if [ \"\$active\" -ge \"\$max_slots\" ]; then
            echo \"[\$(date +%Y-%m-%d_%H:%M:%S)] SPAWN-CHECK: task \${task_id} retry 見送り (active=\${active}/\${max_slots})\"
            sq \"UPDATE tasks SET state='prompt_generated', last_action='spawn_fail_retry_pending' WHERE id = \${task_id} AND state = 'running';\"
            exit 0
        fi

        # retry: state を prompt_generated に戻して次サイクルで再 dispatch
        echo \"[\$(date +%Y-%m-%d_%H:%M:%S)] SPAWN-CHECK: task \${task_id} retry (active=\${active}/\${max_slots})\"
        sq \"UPDATE tasks SET state='prompt_generated', last_action='spawn_fail_retry' WHERE id = \${task_id} AND state = 'running';\"
    " >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1 &
    disown
    # ─── spawn 失敗検出 ここまで ─────────────────────────────────────────────

    echo "Dispatched task ${task_id} (lane=${lane_name}) → ${log_file}"
    return 0
}

if [ "$AUTO_MODE" -eq 1 ]; then
    SLOTS_USED=0
    # 無限ループ防止: dispatch_one が state 未変化のまま失敗し続けても
    # 1 サイクルで有限回しか試行しないよう上限化する。
    ITER_GUARD=0
    MAX_ITER=$((AVAILABLE_SLOTS * 3 + 5))
    while [ "$SLOTS_USED" -lt "$AVAILABLE_SLOTS" ]; do
        ITER_GUARD=$((ITER_GUARD + 1))
        if [ "$ITER_GUARD" -gt "$MAX_ITER" ]; then
            echo "WARNING: dispatch loop guard hit (${ITER_GUARD} iters > ${MAX_ITER}), aborting cycle"
            break
        fi
        NEXT_ID=$(SQ "SELECT id FROM tasks
                      WHERE state = 'prompt_generated' ${NIGHT_FILTER}
                      ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 ELSE 2 END,
                               COALESCE(asana_due_on, '9999-12-31') ASC,
                               id ASC
                      LIMIT 1;")
        if [ -z "$NEXT_ID" ]; then
            # prompt_generated が無ければ pending を 1 件昇格してから dispatch する。
            # これが pending→prompt_generated の唯一の駆動点 (r2c-generate-lane.sh は
            # 純粋テンプレ置換で claude 起動なし)。dispatch と同じ night filter / tier 順を適用。
            PENDING_ID=$(SQ "SELECT id FROM tasks
                          WHERE state = 'pending' ${NIGHT_FILTER}
                          ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 ELSE 2 END,
                                   COALESCE(asana_due_on, '9999-12-31') ASC,
                                   id ASC
                          LIMIT 1;")
            if [ -z "$PENDING_ID" ]; then
                echo "No dispatchable tasks (prompt_generated / pending とも 0, slots used=${SLOTS_USED}/${AVAILABLE_SLOTS})"
                break
            fi
            if [ "$DRY_RUN" -eq 1 ]; then
                echo "[dry-run] would promote pending task ${PENDING_ID} via r2c-generate-lane.sh, then dispatch"
                break
            fi
            echo "Promoting pending task ${PENDING_ID} → prompt_generated (r2c-generate-lane.sh)"
            if bash "${R2C_ROOT}/SCRIPTS/r2c-generate-lane.sh" --task-id "${PENDING_ID}"; then
                NEXT_ID="${PENDING_ID}"
            else
                echo "WARNING: generate-lane failed for ${PENDING_ID}, marking failed"
                SQ "UPDATE tasks SET state='failed', error_message='generate-lane failed', last_action='generate_failed' WHERE id = ${PENDING_ID};"
                continue
            fi
        fi
        if dispatch_one "$NEXT_ID"; then
            SLOTS_USED=$((SLOTS_USED + 1))
        else
            # dispatch_one が state を変えずに失敗した場合 (prompt_path 欠落等の
            # early-return)、同一タスクが毎 iteration 再選択され他タスクが starve する。
            # selectable な状態のままなら failed にして再選択を防ぐ (running/failed 等は不変)。
            echo "WARNING: dispatch_one failed for ${NEXT_ID}, marking failed to avoid re-selection"
            SQ "UPDATE tasks SET state='failed', error_message='dispatch_one failed', last_action='dispatch_failed' WHERE id = ${NEXT_ID} AND state IN ('pending','prompt_generated');"
        fi
    done

    # 要件4: 自走タスク枯渇 + 全 Lane idle + 人間レビュー待ち が揃った時の「無通知 exit」を防ぐ。
    # cron が毎分走るため、通知スパムを避ける throttle(6h) 付きで「通知して静かに待つ」。
    # 実 Slack 送信と automation_state 更新は dry-run では行わない (副作用なしの preview を維持)。
    if [ "$SLOTS_USED" -eq 0 ] && [ "${ACTIVE_COUNT:-0}" -eq 0 ]; then
        HUMAN_GATE=$(SQ "SELECT COUNT(*) FROM tasks WHERE state IN ('needs_approval','needs_approval_critical','ready_to_merge');")
        HUMAN_GATE=${HUMAN_GATE:-0}
        if [ "$HUMAN_GATE" -ge 1 ]; then
            LAST_NOTIFY=$(SQ "SELECT value FROM automation_state WHERE key='drained_notified_at';" || true)
            NOW_EPOCH=$(date +%s)
            THROTTLE_SECS=21600  # 6h
            # 空 / 非数値 (DB 破損等) は「未通知」扱いにして throttle 計算のクラッシュを避ける
            if [ -z "$LAST_NOTIFY" ] || ! [[ "$LAST_NOTIFY" =~ ^[0-9]+$ ]] || [ "$((NOW_EPOCH - LAST_NOTIFY))" -ge "$THROTTLE_SECS" ]; then
                echo "自走タスク枯渇: ${HUMAN_GATE}件が人間レビュー待ち → 通知 (throttle 6h, dry=${DRY_RUN})"
                if [ "$DRY_RUN" -eq 0 ]; then
                    bash "${R2C_ROOT}/SCRIPTS/r2c-slack-notify.sh" --text "🟡 R2C 自走タスク枯渇: dispatch 可能タスク 0件・稼働 Lane 0本。${HUMAN_GATE}件が人間レビュー待ち (needs_approval / ready_to_merge)。ループは待機継続中。" 2>/dev/null || true
                    SQ "INSERT OR REPLACE INTO automation_state (key, value) VALUES ('drained_notified_at', '${NOW_EPOCH}');" || true
                fi
            fi
        fi
    elif [ "$DRY_RUN" -eq 0 ]; then
        # 何か dispatch した / Lane 稼働中 → drained 通知の throttle をリセット
        SQ "DELETE FROM automation_state WHERE key='drained_notified_at';" 2>/dev/null || true
    fi
else
    dispatch_one "$TASK_ID"
fi

echo "[$(date +%Y-%m-%d_%H:%M:%S)] === r2c-dispatch done ==="
echo ""
