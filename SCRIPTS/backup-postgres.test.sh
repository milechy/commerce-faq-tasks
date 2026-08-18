#!/usr/bin/env bash
# backup-postgres.test.sh — backup-postgres.sh の失敗経路を固定する
#
# なぜ必要か:
#   このスクリプトが防ぎたいのは「失敗したのに成果物が残り、成功に見える」こと。
#   ドキュメント記載の `pg_dump $URL | gzip > out.gz` はリダイレクトが先に走るため、
#   pg_dump が失敗しても空の .gz が必ず作られる。毎日ファイルは増えるのに中身が無い、
#   という壊れ方は、必要になるまで誰も気づけない。
#   正常系が通ることより、失敗時に何も残さないことの方が重要なのでそちらを厚く見る。
#
# 実行: bash SCRIPTS/backup-postgres.test.sh
# 本物のDB・Slackには一切触らない（PG_DUMP と NOTIFY を差し替える）。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/backup-postgres.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Slack を叩かないダミー。呼ばれた回数を記録する。
NOTIFY_STUB="${WORK}/notify.sh"
cat > "$NOTIFY_STUB" <<'EOS'
#!/usr/bin/env bash
echo "$*" >> "${NOTIFY_LOG}"
EOS
chmod +x "$NOTIFY_STUB"

mk_env() { printf 'DATABASE_URL=%s\n' "$1" > "${WORK}/env"; }
mk_pgdump() {  # $1: 終了コード, $2: 出力内容
    printf '%s' "$2" > "${WORK}/dump_body"
    cat > "${WORK}/pg_dump" <<EOS
#!/usr/bin/env bash
cat "${WORK}/dump_body"
exit $1
EOS
    chmod +x "${WORK}/pg_dump"
}
run() {
    NOTIFY_LOG="${WORK}/notify.log" \
    ENV_FILE="${WORK}/env" BACKUP_DIR="${WORK}/out" \
    PG_DUMP="${WORK}/pg_dump" NOTIFY="$NOTIFY_STUB" MIN_FREE_MB=0 \
    bash "$TARGET" "$@" >"${WORK}/stdout" 2>"${WORK}/stderr"
}
check() {  # $1: 説明, $2: 実際, $3: 期待
    if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1"
    else FAIL=$((FAIL+1)); echo "  ✗ $1 — 期待:[$3] 実際:[$2]"; fi
}
reset_out() { rm -rf "${WORK}/out" "${WORK}/notify.log"; mkdir -p "${WORK}/out"; touch "${WORK}/notify.log"; }
count_gz() { ls -1 "${WORK}/out"/pg_*.sql.gz 2>/dev/null | wc -l | tr -d ' '; }
count_tmp() { ls -1 "${WORK}/out"/*.tmp 2>/dev/null | wc -l | tr -d ' '; }

# 健全なダンプの中身。先頭に pg_dump のヘッダを置き、本体は圧縮しにくいデータにする。
# MIN_DUMP_BYTES の判定は **圧縮後** のサイズに対して行われるため、
# 同じ文字の繰り返しでは gzip 後に数十バイトまで縮んで下限を割る（実際に踏んだ）。
GOOD_DUMP="-- PostgreSQL database dump
$(head -c 60000 /dev/urandom | base64)"

echo "== 1. DATABASE_URL が空（cron が .env を読まない状況の再現） =="
reset_out; mk_env ""; mk_pgdump 0 "$GOOD_DUMP"
run; rc=$?
check "非ゼロで終了する" "$rc" "1"
check "成果物を作らない" "$(count_gz)" "0"
check "一時ファイルを残さない" "$(count_tmp)" "0"
check "Slack へ通知する" "$([ -s "${WORK}/notify.log" ] && echo yes || echo no)" "yes"
check "接続文字列を出力に含めない" "$(grep -c 'postgres://' "${WORK}/stderr" "${WORK}/notify.log" 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" "0"

echo "== 2. pg_dump が失敗する =="
reset_out; mk_env "postgres://u:p@127.0.0.1:5432/db"; mk_pgdump 1 ""
run; rc=$?
check "非ゼロで終了する" "$rc" "1"
check "空の .gz を残さない（ドキュメント版はここで残る）" "$(count_gz)" "0"
check "一時ファイルを残さない" "$(count_tmp)" "0"

echo "== 3. 接続はできたが中身がほぼ空 =="
reset_out; mk_env "postgres://u:p@127.0.0.1:5432/db"; mk_pgdump 0 "-- PostgreSQL database dump"
run; rc=$?
check "非ゼロで終了する" "$rc" "1"
check "成果物を作らない" "$(count_gz)" "0"

echo "== 4. pg_dump の出力に見えない内容 =="
reset_out; mk_env "postgres://u:p@127.0.0.1:5432/db"
mk_pgdump 0 "$(head -c 60000 /dev/urandom | base64)"
run; rc=$?
check "非ゼロで終了する" "$rc" "1"
check "成果物を作らない" "$(count_gz)" "0"

echo "== 5. 正常系 =="
reset_out; mk_env "postgres://u:p@127.0.0.1:5432/db"; mk_pgdump 0 "$GOOD_DUMP"
run; rc=$?
check "ゼロで終了する" "$rc" "0"
check "成果物が1件できる" "$(count_gz)" "1"
check "一時ファイルを残さない" "$(count_tmp)" "0"
check "Slack へ通知しない" "$([ -s "${WORK}/notify.log" ] && echo yes || echo no)" "no"
check "gzip として健全" "$(gzip -t "${WORK}/out"/pg_*.sql.gz 2>/dev/null && echo ok || echo ng)" "ok"

echo "== 6. 保持期間 =="
reset_out; mk_env "postgres://u:p@127.0.0.1:5432/db"; mk_pgdump 0 "$GOOD_DUMP"
touch -t 200001010000 "${WORK}/out/pg_19991231.sql.gz"
touch "${WORK}/out/pg_20990101.sql.gz"
run >/dev/null 2>&1
check "古いものは削除される" "$([ -f "${WORK}/out/pg_19991231.sql.gz" ] && echo yes || echo no)" "no"
check "新しいものは残る" "$([ -f "${WORK}/out/pg_20990101.sql.gz" ] && echo yes || echo no)" "yes"

echo "== 7. --list は成果物を作らない =="
reset_out; mk_env ""; mk_pgdump 0 "$GOOD_DUMP"
run --list; rc=$?
check "ゼロで終了する" "$rc" "0"
check "成果物を作らない" "$(count_gz)" "0"

echo ""
echo "PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
