#!/usr/bin/env bash
# backup-postgres.sh — 本番 PostgreSQL の日次バックアップ
#
# なぜ必要か:
#   2026-08-18 の実測で、本番DBのバックアップが1本も存在しないことが判明した。
#   さらに docs/DATA_RETENTION_POLICY.md §4.1 は「pg_dump (VPS cron) / 日次 / 7日」と
#   実装済みであるかのように書いていた（§4.2 では同じ cron を「想定」と書いており矛盾）。
#   「バックアップがある」という誤記は、無いことより危険。障害時に復旧できると
#   誤認したまま判断してしまう。
#
# 実行場所: VPS（cron。インストール手順は最下部）
#
# 設計上の約束:
#   - .env を source しない。プレースホルダ（FAL_KEY=<...> 等）がリダイレクトと解釈され、
#     前後の行がコマンドとして実行されてシークレットが露出する（2026-08-08 に実際に起きた）。
#     必要な変数だけ sed で1行取り出す（monitor-avatar-agent.sh と同じ作法）。
#   - DATABASE_URL をログ・Slack・エラー文言に一切出さない。
#   - **失敗したら成果物を残さない。** ドキュメント記載の
#       pg_dump $DATABASE_URL | gzip > /backup/pg_YYYYMMDD.sql.gz
#     をそのまま cron に貼ると、cron は .env を読まないので $DATABASE_URL が空になり、
#     pg_dump は既定のUNIXソケット接続にフォールバックして失敗する。
#     ところが **リダイレクトが先に走るので空または壊れた .gz が必ず作られる**。
#     結果、ファイルは毎日増えるのに中身が無い、という最悪の壊れ方になる。
#     ここでは一時ファイルに書き、健全性を確認してから最終名へ rename する。
#   - 失敗は必ず非ゼロ終了 + Slack 通知。黙って成功に見せない。
#
# 使い方:
#   bash SCRIPTS/backup-postgres.sh              # 通常実行
#   bash SCRIPTS/backup-postgres.sh --dry-run    # 接続と空き容量だけ確認し、dumpしない
#   bash SCRIPTS/backup-postgres.sh --list       # 保管中のバックアップを一覧表示
#
# 関連: docs/DATA_RETENTION_POLICY.md / Asana 1217570014112316

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-/opt/rajiuce/.env}"
BACKUP_DIR="${BACKUP_DIR:-/backup}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"
# 健全なダンプの下限。これを下回ったら失敗として扱う。
# 「接続はできたが中身がほぼ空」を成功と数えないための歯。
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-10240}"
PG_DUMP="${PG_DUMP:-pg_dump}"
# テストから差し替えられるようにしておく。既定は本物の通知スクリプト。
# 差し替え口が無いと、失敗経路のテストが実際に Slack へ投稿してしまう。
NOTIFY="${NOTIFY:-${SCRIPT_DIR}/notify-slack.sh}"

MODE=normal
case "${1:-}" in
  --dry-run) MODE=dry ;;
  --list)    MODE=list ;;
  "")        ;;
  *) echo "使い方: $0 [--dry-run|--list]" >&2; exit 64 ;;
esac

log() { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $*"; }

# .env から1行だけ取り出す（source しない）。monitor-avatar-agent.sh と同じ実装。
load_env_var() {
    [ -f "$ENV_FILE" ] || return 0
    sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^"//; s/"$//'
}

# 失敗を必ず可視化する。Slack が使えない場合でも標準エラーと終了コードには残す。
# 第2引数以降に DATABASE_URL を含む文字列を渡さないこと。
fail() {
    local msg="$1"
    log "ERROR: $msg" >&2
    for _v in SLACK_BOT_TOKEN SLACK_WEBHOOK_URL_R2C SLACK_WEBHOOK_URL; do
        if [ -z "$(eval "echo \${$_v:-}")" ]; then
            _val="$(load_env_var "$_v")"
            [ -n "$_val" ] && export "$_v=$_val"
        fi
    done
    if [ -x "$NOTIFY" ]; then
        bash "$NOTIFY" "🔴 本番DBバックアップ失敗: ${msg}" --color error >/dev/null 2>&1 || true
    fi
    exit 1
}

if [ "$MODE" = "list" ]; then
    log "保管中のバックアップ (${BACKUP_DIR}):"
    ls -lh "${BACKUP_DIR}"/pg_*.sql.gz 2>/dev/null || log "  (1件も無い)"
    exit 0
fi

DB_URL="$(load_env_var DATABASE_URL)"
# 空のまま進むと pg_dump が既定のソケット接続にフォールバックし、
# `FATAL: role "root" does not exist` になる。これは「DBが壊れた」ではなく
# 「値を渡せていない」なので、ここで明示的に止めて誤診を防ぐ。
[ -n "$DB_URL" ] || fail "DATABASE_URL を ${ENV_FILE} から取得できませんでした（cron は .env を自動では読みません）"

mkdir -p "$BACKUP_DIR" 2>/dev/null || fail "バックアップ先 ${BACKUP_DIR} を作成できませんでした"
[ -w "$BACKUP_DIR" ] || fail "バックアップ先 ${BACKUP_DIR} に書き込めません"

FREE_MB="$(df -Pm "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
    fail "空き容量が不足しています（${FREE_MB}MB < ${MIN_FREE_MB}MB）"
fi

if [ "$MODE" = "dry" ]; then
    # 接続確認のみ。dump はしない。エラー本文に接続文字列が混ざらないよう捨てる。
    if "$PG_DUMP" --schema-only --table=__no_such_table__ "$DB_URL" >/dev/null 2>&1; then
        log "dry-run: 接続OK / 空き ${FREE_MB}MB / 出力先 ${BACKUP_DIR}"
    else
        # 存在しないテーブル指定は正常系でも非ゼロになりうるため、接続可否は別途判定する
        if "$PG_DUMP" --schema-only "$DB_URL" >/dev/null 2>&1; then
            log "dry-run: 接続OK / 空き ${FREE_MB}MB / 出力先 ${BACKUP_DIR}"
        else
            fail "DBへ接続できませんでした（接続文字列は表示しません。${ENV_FILE} の DATABASE_URL を確認してください）"
        fi
    fi
    exit 0
fi

STAMP="$(date +%Y%m%d)"
FINAL="${BACKUP_DIR}/pg_${STAMP}.sql.gz"
TMP="${FINAL}.tmp"

rm -f "$TMP"
# pipefail により pg_dump 側の失敗も検出できる。
if ! "$PG_DUMP" "$DB_URL" 2>/dev/null | gzip -c > "$TMP"; then
    rm -f "$TMP"
    fail "pg_dump に失敗しました（成果物は残していません）"
fi

# 「作られたが中身が無い」を成功と数えない。3段階で確かめる。
SIZE="$(wc -c < "$TMP" 2>/dev/null || echo 0)"
if [ "$SIZE" -lt "$MIN_DUMP_BYTES" ]; then
    rm -f "$TMP"
    fail "ダンプが小さすぎます（${SIZE}バイト < ${MIN_DUMP_BYTES}バイト）"
fi
if ! gzip -t "$TMP" 2>/dev/null; then
    rm -f "$TMP"
    fail "ダンプの gzip 整合性チェックに失敗しました"
fi
if ! gzip -dc "$TMP" 2>/dev/null | head -c 4096 | grep -q "PostgreSQL database dump"; then
    rm -f "$TMP"
    fail "ダンプの内容が pg_dump の出力に見えません"
fi

mv -f "$TMP" "$FINAL" || fail "バックアップの確定（rename）に失敗しました"
log "完了: ${FINAL} ($(du -h "$FINAL" | cut -f1))"

# 直前のバックアップから急に小さくなっていないかを見る。
# テーブル削除・部分的な権限喪失は、成功扱いのまま中身だけ痩せるため気づけない。
PREV="$(ls -1t "${BACKUP_DIR}"/pg_*.sql.gz 2>/dev/null | sed -n '2p')"
if [ -n "$PREV" ]; then
    PREV_SIZE="$(wc -c < "$PREV")"
    if [ "$PREV_SIZE" -gt 0 ] && [ "$((SIZE * 2))" -lt "$PREV_SIZE" ]; then
        log "警告: 前回($(basename "$PREV"), ${PREV_SIZE}バイト)の半分未満です" >&2
        for _v in SLACK_BOT_TOKEN SLACK_WEBHOOK_URL_R2C SLACK_WEBHOOK_URL; do
            if [ -z "$(eval "echo \${$_v:-}")" ]; then
                _val="$(load_env_var "$_v")"; [ -n "$_val" ] && export "$_v=$_val"
            fi
        done
        [ -x "$NOTIFY" ] && bash "$NOTIFY" \
            "⚠️ 本番DBバックアップのサイズが前回の半分未満です（${SIZE} < ${PREV_SIZE} バイト）。内容を確認してください" \
            --color warning >/dev/null 2>&1 || true
    fi
fi

# 保持期間を過ぎたものを削除する。削除は最後に行う。
# 先に消すと、今回の取得に失敗したとき手元に何も残らない。
DELETED="$(find "$BACKUP_DIR" -maxdepth 1 -name 'pg_*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l | tr -d ' ')"
[ "$DELETED" != "0" ] && log "保持期間(${RETENTION_DAYS}日)超過を ${DELETED} 件削除しました"

exit 0

# --- VPS へのインストール手順（hkobayashi 手動） ---
#
#   1) 投入前に dry-run で接続と空き容量を確認する:
#        bash /opt/rajiuce/SCRIPTS/backup-postgres.sh --dry-run
#
#   2) 手動で1回実行し、実ファイルが出ることを確認する:
#        bash /opt/rajiuce/SCRIPTS/backup-postgres.sh
#        bash /opt/rajiuce/SCRIPTS/backup-postgres.sh --list
#
#   3) crontab -e で以下を追加（毎日 02:00）:
#        0 2 * * * bash /opt/rajiuce/SCRIPTS/backup-postgres.sh >> /var/log/r2c-pg-backup.log 2>&1
#
#   4) **翌日に実ファイルとサイズを確認する。** cron を書いた＝動作確認ではない:
#        bash /opt/rajiuce/SCRIPTS/backup-postgres.sh --list
#
#   5) **リストアを1度だけ実地で試す。** 取れているが戻せない、が最悪のケース。
#      本番へ流し込まないこと。検証用DBを作って戻す:
#        createdb -T template0 restore_test
#        gzip -dc /backup/pg_YYYYMMDD.sql.gz | psql restore_test
#        psql restore_test -c '\dt' | head
#        dropdb restore_test
