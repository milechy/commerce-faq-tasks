#!/usr/bin/env bash
# migrate-alert-db-v2.sh — alerts table の v1 → v2 schema 移行スクリプト
# Phase70-L Round 3 (Codex Round 2 high #2 対応の DB スキーマ拡張)
#
# 目的:
#   notify-slack.sh の v2 schema 拡張に伴い、既存の v1 alerts table に
#   下記 3 列を追加する。primary send 失敗時の delivery_status 追跡 +
#   将来の retry/backoff 実装の余地確保 (本 PR では retry_count の logic は未実装)。
#
# 追加列:
#   - delivery_status TEXT DEFAULT 'pending'   — pending / delivered / failed
#   - retry_count     INTEGER DEFAULT 0        — 予約。本 PR では未使用 (別 PR で backoff 実装予定)
#   - last_attempt_at INTEGER                  — 最終 send 試行の Unix timestamp
#
# 使い方:
#   bash SCRIPTS/migrate-alert-db-v2.sh                       # default DB を v2 へ migrate
#   ALERT_DB_PATH=/path/to/alerts.db bash SCRIPTS/migrate-alert-db-v2.sh
#   bash SCRIPTS/migrate-alert-db-v2.sh --dry-run             # 影響範囲を表示のみ
#   bash SCRIPTS/migrate-alert-db-v2.sh --rollback            # v2 列を削除し v1 へ戻す
#
# 後方互換性:
#   - 既存の v1 rows は delivery_status=NULL のまま (DEFAULT は新規 row にのみ適用)
#   - notify-slack.sh / escalation-test.sh は NULL を delivered と区別せず処理 (count_unescalated は escalated 列のみ参照)
#
# Idempotency:
#   - 既に v2 へ移行済みの DB に対して再実行しても no-op (ALTER の error は ignored)

set -euo pipefail

ALERT_DB_PATH="${ALERT_DB_PATH:-/tmp/r2c-alert-count.db}"
DRY_RUN=0
ROLLBACK=0

usage() {
    cat <<'USAGE'
Usage: migrate-alert-db-v2.sh [--dry-run] [--rollback]

Migrate alerts table from v1 to v2 schema (adds delivery_status / retry_count / last_attempt_at columns).

Options:
  --dry-run    Show current schema and intended changes without applying
  --rollback   Restore v1 schema (drops the 3 new columns via table rebuild)

Environment:
  ALERT_DB_PATH   Path to sqlite3 DB (default: /tmp/r2c-alert-count.db)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)  DRY_RUN=1; shift ;;
        --rollback) ROLLBACK=1; shift ;;
        -h|--help)  usage; exit 0 ;;
        *)          echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "ERROR: sqlite3 required but not installed" >&2
    exit 1
fi

if [[ ! -f "$ALERT_DB_PATH" ]]; then
    echo "ERROR: DB not found at $ALERT_DB_PATH" >&2
    echo "Hint: notify-slack.sh の初回呼び出し時に自動作成されます" >&2
    exit 1
fi

# 現在 schema を表示
current_schema() {
    sqlite3 "$ALERT_DB_PATH" "PRAGMA table_info(alerts);" 2>/dev/null
}

# 指定列が既存か (cid|name|type|notnull|dflt|pk の name 列で照合)
has_column() {
    local col="$1"
    current_schema | awk -F'|' -v c="$col" '$2==c {found=1} END {exit !found}'
}

V2_COLUMNS=(
    "delivery_status:TEXT DEFAULT 'pending'"
    "retry_count:INTEGER DEFAULT 0"
    "last_attempt_at:INTEGER"
)

if [[ "$ROLLBACK" -eq 1 ]]; then
    echo "[migrate] ROLLBACK mode: dropping v2 columns from $ALERT_DB_PATH"
    if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "[migrate] [dry-run] would rebuild alerts table without delivery_status/retry_count/last_attempt_at"
        exit 0
    fi
    # SQLite (<3.35) は DROP COLUMN 非対応のため、table rebuild で対応 (確実な方法)
    # 注意: PRAGMA busy_timeout=5000 の "5000" 出力を抑制するため /dev/null へ
    sqlite3 "$ALERT_DB_PATH" >/dev/null <<'SQL'
PRAGMA busy_timeout=5000;
BEGIN IMMEDIATE;
CREATE TABLE alerts_v1_tmp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  escalated INTEGER NOT NULL DEFAULT 0
);
INSERT INTO alerts_v1_tmp (id, alert_type, message, created_at, escalated)
  SELECT id, alert_type, message, created_at, escalated FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_v1_tmp RENAME TO alerts;
CREATE INDEX IF NOT EXISTS idx_alerts_type_escalated
  ON alerts(alert_type, escalated);
COMMIT;
SQL
    echo "[migrate] rollback complete — schema:"
    current_schema
    exit 0
fi

# Forward migration (v1 → v2)
echo "[migrate] target DB: $ALERT_DB_PATH"
echo "[migrate] current schema:"
current_schema | sed 's/^/    /'

NEEDS_MIGRATION=0
for col_spec in "${V2_COLUMNS[@]}"; do
    col_name="${col_spec%%:*}"
    if ! has_column "$col_name"; then
        NEEDS_MIGRATION=1
        echo "[migrate] missing column: $col_name"
    fi
done

if [[ "$NEEDS_MIGRATION" -eq 0 ]]; then
    echo "[migrate] DB already at v2 — no-op"
    exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[migrate] [dry-run] would apply:"
    for col_spec in "${V2_COLUMNS[@]}"; do
        col_name="${col_spec%%:*}"
        col_def="${col_spec#*:}"
        if ! has_column "$col_name"; then
            echo "    ALTER TABLE alerts ADD COLUMN $col_name $col_def;"
        fi
    done
    exit 0
fi

# 適用 (各 ALTER は個別 transaction、ALREADY EXISTS は ignored)
for col_spec in "${V2_COLUMNS[@]}"; do
    col_name="${col_spec%%:*}"
    col_def="${col_spec#*:}"
    if has_column "$col_name"; then
        echo "[migrate] skip $col_name (already present)"
        continue
    fi
    if sqlite3 "$ALERT_DB_PATH" "ALTER TABLE alerts ADD COLUMN $col_name $col_def;" 2>/dev/null; then
        echo "[migrate] added $col_name"
    else
        echo "[migrate] WARN: failed to add $col_name (may already exist concurrently)" >&2
    fi
done

# WAL mode 有効化 (per-DB 設定、persistent)
sqlite3 "$ALERT_DB_PATH" "PRAGMA journal_mode=WAL;" >/dev/null 2>&1 || true

echo "[migrate] complete — new schema:"
current_schema | sed 's/^/    /'
exit 0
