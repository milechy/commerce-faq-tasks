#!/usr/bin/env bash
# r2c-test-seeder.sh — テストなし src モジュールを tier-b-test キューに自動追加
#
# 用途: src/ を走査し、対応 .test.ts がないモジュールを検出して
#       r2c-queue-add.sh 経由で tier-b-test タスクとして queue に INSERT する。
#       idempotent: asana_gid = "test-seed-<safe-path>" で ON CONFLICT DO NOTHING。
#
# 除外対象:
#   HIGH ディレクトリ: src/middleware/, src/api/auth*, src/agent/security/
#   純型ファイル: index.ts, types.ts, *.d.ts, contracts.ts
#   __tests__/ 配下
#
# オプション:
#   --max-tasks <N>   一回の実行で追加する上限 (default 10)
#   --dry-run         追加対象リストを stdout に出力して終了
#   --include-high    HIGH ディレクトリもスキャン対象に含める
#   -h, --help
#
# 呼び出し例:
#   bash SCRIPTS/r2c-test-seeder.sh --dry-run
#   bash SCRIPTS/r2c-test-seeder.sh --max-tasks 5

set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_ROOT="${R2C_ROOT:-$HOME/projects/commerce-faq-tasks}"
R2C_CONFIG="${R2C_CONFIG:-$HOME/.claude-r2c-config}"
QUEUE_DB="${QUEUE_DB:-${R2C_ROOT}/.claude/queue/r2c-queue.db}"
LOG_DIR="${R2C_CONFIG}/logs"
SRC_DIR="${R2C_ROOT}/src"
QUEUE_ADD_BIN="${R2C_ROOT}/SCRIPTS/r2c-queue-add.sh"

MAX_TASKS=10
DRY_RUN=0
INCLUDE_HIGH=0

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --max-tasks)  MAX_TASKS="${2:?}"; shift 2 ;;
        --dry-run)    DRY_RUN=1; shift ;;
        --include-high) INCLUDE_HIGH=1; shift ;;
        -h|--help)    usage; exit 0 ;;
        *)            echo "ERROR: unknown arg: $1" >&2; usage >&2; exit 1 ;;
    esac
done

if ! printf '%s' "$MAX_TASKS" | grep -qE '^[0-9]+$'; then
    echo "ERROR: --max-tasks must be non-negative integer" >&2; exit 1
fi

mkdir -p "$LOG_DIR"
if [[ "$DRY_RUN" -eq 0 ]]; then
    exec >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1
fi

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >&2; }

log "=== r2c-test-seeder start (max=${MAX_TASKS} dry=${DRY_RUN}) ==="

if [[ ! -d "$SRC_DIR" ]]; then
    log "ERROR: src dir not found: $SRC_DIR"
    exit 1
fi

if [[ "$DRY_RUN" -eq 0 ]] && [[ ! -f "$QUEUE_DB" ]]; then
    log "ERROR: queue DB not found: $QUEUE_DB (run r2c-queue-init.sh first)"
    exit 1
fi

# ─── 除外パターン ─────────────────────────────────────────────────────────
# HIGH ディレクトリ (auto-merge ブロック対象)
HIGH_PATTERN="src/middleware/|src/api/auth|src/agent/security/"
# 純型・インデックス・設定ファイル
SKIP_BASENAME_RE="^(index|types|contracts|env|supabaseClient)\.ts$"
# _でも test でもない拡張子除外
TS_SKIP_RE="\.(d|test)\.ts$"

# ─── DB 照合ヘルパー ─────────────────────────────────────────────────────
gid_exists_in_queue() {
    local gid="$1"
    local cnt
    cnt=$(sqlite3 "$QUEUE_DB" \
        "SELECT COUNT(*) FROM tasks WHERE asana_gid='$(printf '%s' "$gid" | sed "s/'/\'\'/g")';" \
        2>/dev/null || echo "0")
    [[ "${cnt:-0}" -gt 0 ]]
}

# ─── synthetic GID 生成 (path ベース、idempotent) ────────────────────────
# 例: src/search/ceEngine.ts → test-seed-src-search-ceEngine-ts (最大 60 文字)
make_gid() {
    local relpath="$1"
    local safe
    safe=$(printf '%s' "$relpath" | tr '/' '-' | tr '.' '-' | tr '_' '-')
    printf 'test-seed-%s' "${safe:0:50}"
}

# ─── notes (Lane 向け指示) ───────────────────────────────────────────────
make_notes() {
    local relpath="$1"
    printf '対象モジュール: %s\nカバーすべき観点: 正常系・境界値・異常系\n外部依存はモック必須 (DB/fetch/Groq/ES 等)\n' "$relpath"
}

# ─── スキャン ─────────────────────────────────────────────────────────────
ADDED=0
SKIPPED=0
ALREADY_QUEUED=0

while IFS= read -r abs_path; do
    relpath="${abs_path#"${R2C_ROOT}/"}"
    base=$(basename "$abs_path")

    # 拡張子除外 (.d.ts / .test.ts)
    if printf '%s' "$base" | grep -qE "$TS_SKIP_RE"; then
        continue
    fi

    # 純型/インデックス除外
    if printf '%s' "$base" | grep -qE "$SKIP_BASENAME_RE"; then
        SKIPPED=$(( SKIPPED + 1 ))
        continue
    fi

    # HIGH ディレクトリ除外
    if [[ "$INCLUDE_HIGH" -eq 0 ]] && printf '%s' "$relpath" | grep -qE "$HIGH_PATTERN"; then
        SKIPPED=$(( SKIPPED + 1 ))
        continue
    fi

    # 対応 .test.ts が既に存在するか
    test_file="${abs_path%.ts}.test.ts"
    if [[ -f "$test_file" ]]; then
        continue
    fi

    # synthetic GID
    GID=$(make_gid "$relpath")
    NAME="[auto-test] Add unit tests for ${relpath}"
    NOTES=$(make_notes "$relpath")

    if [[ "$DRY_RUN" -eq 1 ]]; then
        printf 'DRY: %-60s  gid=%s\n' "$relpath" "$GID"
        ADDED=$(( ADDED + 1 ))
        if [[ "$ADDED" -ge "$MAX_TASKS" ]]; then break; fi
        continue
    fi

    # DB 重複チェック
    if gid_exists_in_queue "$GID"; then
        ALREADY_QUEUED=$(( ALREADY_QUEUED + 1 ))
        continue
    fi

    # キューに追加
    bash "$QUEUE_ADD_BIN" \
        --asana-gid "$GID" \
        --name     "$NAME" \
        --tier     "B" \
        --task-type "test" \
        --notes    "$NOTES" \
        --night-mode-allowed 1 \
        >> "${LOG_DIR}/${SCRIPT_NAME}.log" 2>&1 && {
        log "  queued: $relpath (gid=$GID)"
        ADDED=$(( ADDED + 1 ))
    } || {
        log "  WARN: queue-add failed for $relpath"
    }

    if [[ "$ADDED" -ge "$MAX_TASKS" ]]; then
        log "  reached max-tasks=${MAX_TASKS}, stopping"
        break
    fi

done < <(find "$SRC_DIR" -name '*.ts' ! -name '*.test.ts' ! -name '*.d.ts' \
    ! -path '*/__tests__/*' | sort)

log "=== done: added=${ADDED} already_queued=${ALREADY_QUEUED} skipped=${SKIPPED} ==="

if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '\n[dry-run summary] would-add=%d (max=%d) skipped=%d\n' \
        "$ADDED" "$MAX_TASKS" "$SKIPPED"
fi
