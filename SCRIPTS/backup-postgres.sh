#!/usr/bin/env bash
# backup-postgres.sh — 本番 PostgreSQL の日次バックアップ
#
# オフサイト複製について:
#   このスクリプトの保存先(/backup)は本番 VPS と同一ホスト。VPS 全損時に道連れになる。
#   物理的に離れた場所(Cloudflare R2)への複製は SCRIPTS/backup-offsite.sh を
#   本スクリプトの直後に cron で走らせて行う。詳細は docs/BACKUP_AND_MONITORING.md。
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
#   bash SCRIPTS/backup-postgres.sh --restore-test [ファイル]
#                                                # 検証用DBへ実際に戻して健全性を確かめる
#                                                # (省略時は最新のバックアップ)
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
PSQL="${PSQL:-psql}"
# 検証用DBの名前は固定する。呼び出し側に決めさせない。
# 変数にすると、いつか本番のDB名が渡されて DROP される事故が起きる。
RESTORE_TEST_DB="r2c_restore_test"
# テストから差し替えられるようにしておく。既定は本物の通知スクリプト。
# 差し替え口が無いと、失敗経路のテストが実際に Slack へ投稿してしまう。
NOTIFY="${NOTIFY:-${SCRIPT_DIR}/notify-slack.sh}"

MODE=normal
RESTORE_FILE=""
case "${1:-}" in
  --dry-run)     MODE=dry ;;
  --list)        MODE=list ;;
  --restore-test) MODE=restore; RESTORE_FILE="${2:-}" ;;
  "")            ;;
  *) echo "使い方: $0 [--dry-run|--list|--restore-test [ファイル]]" >&2; exit 64 ;;
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

if [ "$MODE" = "restore" ]; then
    # 取れているが戻せない、が最悪のケース。テストで代替できない唯一の検証なので、
    # 手組みの一行コマンドを本番へ投げるのではなくここに置く。
    # 定期的に繰り返すべき作業でもある(バックアップは静かに腐る)。
    [ -n "$RESTORE_FILE" ] || RESTORE_FILE="$(ls -1t "${BACKUP_DIR}"/pg_*.sql.gz 2>/dev/null | head -1)"
    [ -n "$RESTORE_FILE" ] || fail "検証するバックアップがありません（${BACKUP_DIR} が空です）"
    [ -f "$RESTORE_FILE" ] || fail "指定されたバックアップが見つかりません: ${RESTORE_FILE}"

    # 接続文字列から検証用DBのURLを導く。クエリ文字列(?sslmode=... 等)は保持する。
    BASE="${DB_URL%%\?*}"
    QS="${DB_URL#"$BASE"}"
    SRC_DB="${BASE##*/}"
    TEST_URL="${BASE%/*}/${RESTORE_TEST_DB}${QS}"

    # 最重要のガード。導出を1文字でも誤ると本番DBを DROP しかねない。
    # 「検証用の名前になっていること」と「元のDBと違うこと」の両方を確かめる。
    [ "${RESTORE_TEST_DB}" != "${SRC_DB}" ] \
        || fail "検証用DB名が本番DB名と同一です。中止しました"
    case "$TEST_URL" in
        *"/${RESTORE_TEST_DB}"|*"/${RESTORE_TEST_DB}?"*) ;;
        *) fail "検証用DBのURLを正しく導出できませんでした。中止しました" ;;
    esac

    log "リストア検証: ${RESTORE_FILE} → ${RESTORE_TEST_DB}"
    "$PSQL" "$DB_URL" -q -c "DROP DATABASE IF EXISTS ${RESTORE_TEST_DB}" >/dev/null 2>&1 \
        || fail "検証用DBの初期化に失敗しました"
    "$PSQL" "$DB_URL" -q -c "CREATE DATABASE ${RESTORE_TEST_DB} TEMPLATE template0" >/dev/null 2>&1 \
        || fail "検証用DBの作成に失敗しました"

    RESTORE_ERR="$(mktemp)"
    # ON_ERROR_STOP を付けないと、途中のエラーを無視して最後まで走り「成功」に見える。
    if ! gzip -dc "$RESTORE_FILE" 2>/dev/null | "$PSQL" "$TEST_URL" -q -v ON_ERROR_STOP=1 >/dev/null 2>"$RESTORE_ERR"; then
        ERR_HEAD="$(head -3 "$RESTORE_ERR" | tr '\n' ' ')"
        rm -f "$RESTORE_ERR"
        "$PSQL" "$DB_URL" -q -c "DROP DATABASE IF EXISTS ${RESTORE_TEST_DB}" >/dev/null 2>&1
        fail "リストアに失敗しました: ${ERR_HEAD}"
    fi
    rm -f "$RESTORE_ERR"

    TABLES="$("$PSQL" "$TEST_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d ' ')"
    SRC_TABLES="$("$PSQL" "$DB_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d ' ')"

    "$PSQL" "$DB_URL" -q -c "DROP DATABASE IF EXISTS ${RESTORE_TEST_DB}" >/dev/null 2>&1 \
        || log "警告: 検証用DB ${RESTORE_TEST_DB} の後片付けに失敗しました。手動で削除してください" >&2

    # 戻せたことと、戻した中身が本番と釣り合っていることは別。両方見る。
    [ -n "$TABLES" ] && [ "$TABLES" -gt 0 ] 2>/dev/null \
        || fail "リストアはできましたが、テーブルが1つもありません"
    if [ -n "$SRC_TABLES" ] && [ "$SRC_TABLES" -gt 0 ] 2>/dev/null && [ "$TABLES" -lt "$SRC_TABLES" ]; then
        fail "リストア後のテーブル数が本番より少ないです（${TABLES} < ${SRC_TABLES}）"
    fi
    log "リストア検証OK: テーブル ${TABLES}件（本番 ${SRC_TABLES}件）。検証用DBは削除済み"
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
# head が先に閉じると gzip に SIGPIPE が飛び、pipefail のせいで
# grep が一致していてもパイプライン全体が非ゼロになる。
# Linux(本番・CI)で顕在化し、macOS では再現しなかった。ダンプが大きいほど確実に踏むため、
# そのままだと「取得に成功した直後に失敗と判定してファイルを消す」動きになる。
# パイプの終了コードに依存させず、取り出した文字列だけで判定する。
HEAD_TEXT="$(gzip -dc "$TMP" 2>/dev/null | head -c 4096 || true)"
case "$HEAD_TEXT" in
    *"PostgreSQL database dump"*) ;;
    *)
        rm -f "$TMP"
        fail "ダンプの内容が pg_dump の出力に見えません"
        ;;
esac

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
#   3) crontab -e で以下を追加。
#      **cron はサーバのタイムゾーンで動く。VPS は UTC。**
#      JST 深夜 02:00 に取りたいなら 17:00 UTC を指定する。
#      「0 2」と書くと 11:00 JST = 日本の業務時間帯に走る（最初これで入れて後から直した）:
#        0 17 * * * bash /opt/rajiuce/SCRIPTS/backup-postgres.sh >> /var/log/r2c-pg-backup.log 2>&1
#
#      既存の cron 行（avatar-agent 監視）を消さないよう、追記形式で入れること:
#        crontab -l 2>/dev/null | grep -q backup-postgres || \
#          (crontab -l 2>/dev/null; echo "0 17 * * * bash /opt/rajiuce/SCRIPTS/backup-postgres.sh >> /var/log/r2c-pg-backup.log 2>&1") | crontab -
#
#   4) **翌日に実ファイルとサイズを確認する。** cron を書いた＝動作確認ではない:
#        bash /opt/rajiuce/SCRIPTS/backup-postgres.sh --list
#
#   5) リストアを実地で試す。取れているが戻せない、が最悪のケース:
#        bash /opt/rajiuce/SCRIPTS/backup-postgres.sh --restore-test
#
#      検証用DB(r2c_restore_test)を作って最新のバックアップを戻し、
#      テーブル数を本番と突き合わせてから削除する。本番には書き込まない。
#      DB名は固定で、本番DB名と同一なら DROP 前に中止する。
#      **一度きりにしないこと。** バックアップは静かに腐るので定期的に回す。
