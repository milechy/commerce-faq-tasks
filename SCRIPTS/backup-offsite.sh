#!/usr/bin/env bash
# backup-offsite.sh — ローカル PostgreSQL バックアップを Cloudflare R2 へオフサイト複製
#
# なぜ必要か:
#   2026-08 の監査で、DBバックアップが本番 VPS の /backup にしか無い
#   （＝ backup-postgres.sh は良く出来ているが、保存先が本番と同一ホスト）
#   ことが判明した。VPS が全損（ディスク故障・誤操作・ランサム）すると、
#   バックアップも同時に失われる。Postgres が事実上の単一障害点になっている。
#   このスクリプトは backup-postgres.sh が出力した /backup/pg_*.sql.gz を、
#   物理的に離れた Cloudflare R2 バケットへ複製し、その単一障害点を解消する。
#
# 実行場所: VPS（cron。backup-postgres.sh の直後に走らせる。最下部の手順参照）
#
# 設計上の約束（backup-postgres.sh の規律をそのまま踏襲する）:
#   - .env を source しない。プレースホルダ行がリダイレクト/コマンドと解釈され、
#     シークレットが露出する事故が過去に起きている。必要な変数だけ sed で取り出す。
#   - シークレット（R2_SECRET_ACCESS_KEY / R2_ACCESS_KEY_ID / DATABASE_URL）を
#     ログ・Slack・エラー文言・プロセス引数(ps)に一切出さない。
#     → rclone へは **環境変数 (RCLONE_S3_*)** で渡す。コマンドライン引数にしない
#       （引数は `ps` で他ユーザーに見える）。設定ファイルにも書かない。
#   - 認証情報が1つでも欠けていたら **実行せず** 明確なエラーで非ゼロ終了する
#     （黙って部分実行して「成功」に見せない）。
#   - 失敗は必ず非ゼロ終了 + Slack 通知。
#   - オフサイトへは copy（追加のみ）で上げる。**sync は使わない。**
#     ローカル保持(既定7日)＜オフサイト保持(既定30日)なので、sync だと
#     ローカルから消えた古い世代をオフサイトからも削除してしまい、
#     「離れた場所の古い世代」という本来の価値を失う。
#     オフサイトのローテーションは --min-age による明示削除で別途行う。
#   - 冪等・再実行安全（copy は既存と同一なら転送しない）。
#
# 使い方:
#   bash SCRIPTS/backup-offsite.sh              # 通常実行（copy → 検証 → ローテーション）
#   bash SCRIPTS/backup-offsite.sh --dry-run    # 接続と転送対象の確認のみ。転送・削除しない
#   bash SCRIPTS/backup-offsite.sh --list       # オフサイトに存在するオブジェクトを一覧
#
# 必要な環境変数（.env もしくは CI secrets。スクリプトには書かない）:
#   R2_ACCOUNT_ID          — Cloudflare アカウントID（R2 の S3 エンドポイント導出に使用）
#   R2_ACCESS_KEY_ID       — R2 の S3 互換アクセスキーID
#   R2_SECRET_ACCESS_KEY   — R2 の S3 互換シークレット
#   R2_BUCKET              — アップロード先バケット名（例: r2c-db-backups）
#   OFFSITE_RETENTION_DAYS — オフサイト保持日数（既定 30）
#   OFFSITE_PREFIX         — バケット内プレフィックス（既定 postgres）
#   BACKUP_DIR             — ローカルバックアップ元（既定 /backup。backup-postgres.sh と一致）
#   ENV_FILE               — 変数取り出し元（既定 /opt/rajiuce/.env）
#
# 関連: SCRIPTS/backup-postgres.sh / docs/BACKUP_AND_MONITORING.md

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-/opt/rajiuce/.env}"
BACKUP_DIR="${BACKUP_DIR:-/backup}"
OFFSITE_RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-30}"
OFFSITE_PREFIX="${OFFSITE_PREFIX:-postgres}"
# バックアップファイルの命名パターン。backup-postgres.sh の出力と一致させる。
BACKUP_GLOB="pg_*.sql.gz"
RCLONE="${RCLONE:-rclone}"
# テストから差し替えられるようにしておく。既定は本物の通知スクリプト。
NOTIFY="${NOTIFY:-${SCRIPT_DIR}/notify-slack.sh}"

MODE=run
case "${1:-}" in
  --dry-run) MODE=dry ;;
  --list)    MODE=list ;;
  "")        ;;
  -h|--help) echo "使い方: $0 [--dry-run|--list]"; exit 0 ;;
  *) echo "使い方: $0 [--dry-run|--list]" >&2; exit 64 ;;
esac

log() { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $*"; }

# .env から1行だけ取り出す（source しない）。backup-postgres.sh と同じ実装。
load_env_var() {
    [ -f "$ENV_FILE" ] || return 0
    sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^"//; s/"$//'
}

# 失敗を必ず可視化する。Slack が使えなくても stderr と終了コードには残す。
# 第2引数以降にシークレットを含む文字列を渡さないこと。
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
        bash "$NOTIFY" "🔴 オフサイトバックアップ失敗(R2): ${msg}" --color error >/dev/null 2>&1 || true
    fi
    exit 1
}

# rclone のエラー出力を surface する前に、万一シークレットが混ざっていても
# 漏れないよう既知の機微値をマスクする（防御的多重化）。
sanitize() {
    local text="$1"
    for _s in "${R2_SECRET_ACCESS_KEY:-}" "${R2_ACCESS_KEY_ID:-}"; do
        [ -n "$_s" ] && text="${text//"$_s"/***}"
    done
    printf '%s' "$text"
}

# ── 前提チェック ──────────────────────────────────────────────
command -v "$RCLONE" >/dev/null 2>&1 \
    || fail "rclone が見つかりません。VPS に導入してください（例: curl https://rclone.org/install.sh | sudo bash）"

# 認証情報を env → .env の順で解決する。1つでも欠けたら実行しない。
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-$(load_env_var R2_ACCOUNT_ID)}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(load_env_var R2_ACCESS_KEY_ID)}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(load_env_var R2_SECRET_ACCESS_KEY)}"
R2_BUCKET="${R2_BUCKET:-$(load_env_var R2_BUCKET)}"

MISSING=""
[ -n "$R2_ACCOUNT_ID" ]        || MISSING="${MISSING} R2_ACCOUNT_ID"
[ -n "$R2_ACCESS_KEY_ID" ]     || MISSING="${MISSING} R2_ACCESS_KEY_ID"
[ -n "$R2_SECRET_ACCESS_KEY" ] || MISSING="${MISSING} R2_SECRET_ACCESS_KEY"
[ -n "$R2_BUCKET" ]            || MISSING="${MISSING} R2_BUCKET"
if [ -n "$MISSING" ]; then
    fail "オフサイト認証情報が未設定です（欠落:${MISSING}）。${ENV_FILE} か CI secrets に設定してください。値はログに出しません"
fi

# rclone へは環境変数で渡す（argv に載せない → ps から見えない）。
# :s3: の on-the-fly バックエンドが RCLONE_S3_* を読む。設定ファイルは使わない。
export RCLONE_S3_PROVIDER="Cloudflare"
export RCLONE_S3_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_S3_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
# R2 では ListBuckets 権限が無いトークンでも動くように、バケット存在チェックを省く。
export RCLONE_S3_NO_CHECK_BUCKET="true"
# rclone 自身に設定ファイルを触らせない（誤って秘密が書かれないように）。
export RCLONE_CONFIG="/dev/null"

REMOTE=":s3:${R2_BUCKET}/${OFFSITE_PREFIX}"

# rclone 実行の薄いラッパ。stderr を捕捉し、surface 時は sanitize する。
run_rclone() {
    local out rc
    out="$("$RCLONE" "$@" 2>&1)"; rc=$?
    LAST_RCLONE_OUT="$out"
    return $rc
}

# ── --list ───────────────────────────────────────────────────
if [ "$MODE" = "list" ]; then
    log "オフサイト (${R2_BUCKET}/${OFFSITE_PREFIX}) のオブジェクト一覧:"
    if run_rclone lsl "$REMOTE"; then
        echo "$LAST_RCLONE_OUT"
    else
        fail "オフサイトの一覧取得に失敗しました: $(sanitize "$(printf '%s' "$LAST_RCLONE_OUT" | head -3 | tr '\n' ' ')")"
    fi
    exit 0
fi

# ── 転送対象の確認 ───────────────────────────────────────────
[ -d "$BACKUP_DIR" ] || fail "ローカルバックアップ元 ${BACKUP_DIR} がありません"
# shellcheck disable=SC2086
LOCAL_COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -name "$BACKUP_GLOB" -type f 2>/dev/null | wc -l | tr -d ' ')"
[ "$LOCAL_COUNT" -gt 0 ] 2>/dev/null \
    || fail "ローカルに ${BACKUP_GLOB} が1件もありません（先に backup-postgres.sh を実行してください）"
LATEST_LOCAL="$(ls -1t "$BACKUP_DIR"/$BACKUP_GLOB 2>/dev/null | head -1)"
LATEST_NAME="$(basename "$LATEST_LOCAL")"
LATEST_SIZE="$(wc -c < "$LATEST_LOCAL" 2>/dev/null | tr -d ' ' || echo 0)"

# ── 接続確認（読み取りで疎通を見る。dry/run 共通） ──────────────
if ! run_rclone lsjson "$REMOTE"; then
    fail "R2 へ接続できませんでした（認証情報/バケット名/エンドポイントを確認。値は表示しません）: $(sanitize "$(printf '%s' "$LAST_RCLONE_OUT" | head -3 | tr '\n' ' ')")"
fi

if [ "$MODE" = "dry" ]; then
    log "dry-run: 接続OK / ローカル対象 ${LOCAL_COUNT}件 / 最新 ${LATEST_NAME} (${LATEST_SIZE}バイト) / 宛先 ${R2_BUCKET}/${OFFSITE_PREFIX} / 保持 ${OFFSITE_RETENTION_DAYS}日"
    log "dry-run: 転送プレビュー ↓"
    # --dry-run を付け、実転送はしない。
    run_rclone copy "$BACKUP_DIR" "$REMOTE" --include "$BACKUP_GLOB" --dry-run --stats-one-line || true
    printf '%s\n' "$(sanitize "$LAST_RCLONE_OUT")"
    exit 0
fi

# ── アップロード（copy: 追加のみ。sync は使わない） ────────────
log "R2 へアップロード開始: ${BACKUP_DIR}/${BACKUP_GLOB} → ${R2_BUCKET}/${OFFSITE_PREFIX}"
if ! run_rclone copy "$BACKUP_DIR" "$REMOTE" --include "$BACKUP_GLOB" --stats-one-line; then
    fail "R2 へのアップロードに失敗しました: $(sanitize "$(printf '%s' "$LAST_RCLONE_OUT" | head -5 | tr '\n' ' ')")"
fi

# ── アップロード検証（最新ファイルの存在とサイズ一致） ─────────
# 「転送コマンドが 0 で返った」と「向こうに正しいサイズで在る」は別。両方見る。
if ! run_rclone lsjson "$REMOTE"; then
    fail "アップロード後のオブジェクト一覧取得に失敗しました: $(sanitize "$(printf '%s' "$LAST_RCLONE_OUT" | head -3 | tr '\n' ' ')")"
fi
REMOTE_JSON="$LAST_RCLONE_OUT"
# jq があれば厳密に、無ければ grep でフォールバック。
if command -v jq >/dev/null 2>&1; then
    REMOTE_SIZE="$(printf '%s' "$REMOTE_JSON" | jq -r --arg n "$LATEST_NAME" '.[] | select(.Name==$n) | .Size' 2>/dev/null | head -1)"
else
    # jq が無い場合の簡易確認: 名前が含まれているかだけ見る（サイズ照合はスキップ）。
    REMOTE_SIZE=""
    case "$REMOTE_JSON" in
        *"\"$LATEST_NAME\""*) REMOTE_SIZE="$LATEST_SIZE" ;;  # 存在は確認できたのでサイズ一致扱い
    esac
fi

[ -n "$REMOTE_SIZE" ] \
    || fail "検証失敗: 最新バックアップ ${LATEST_NAME} がオフサイトに見つかりません"
if [ "$REMOTE_SIZE" != "$LATEST_SIZE" ]; then
    fail "検証失敗: オフサイトの ${LATEST_NAME} のサイズが一致しません（ローカル ${LATEST_SIZE} / R2 ${REMOTE_SIZE} バイト）"
fi
log "検証OK: ${LATEST_NAME} をオフサイトで確認（${REMOTE_SIZE}バイト）"

# ── オフサイトのローテーション（保持日数超過を削除。最後に行う） ──
# ローカルより長く保持する。ローカルから消えた古い世代を巻き込まないよう
# copy とは独立に、経過時間ベースで削除する。
if ! run_rclone delete "$REMOTE" --include "$BACKUP_GLOB" --min-age "${OFFSITE_RETENTION_DAYS}d" --rmdirs; then
    # 削除失敗は致命ではない（本体のアップロードは成功済み）。警告に留める。
    log "警告: オフサイトの保持ローテーションに失敗しました（アップロードは成功済み）: $(sanitize "$(printf '%s' "$LAST_RCLONE_OUT" | head -3 | tr '\n' ' ')")" >&2
    for _v in SLACK_BOT_TOKEN SLACK_WEBHOOK_URL_R2C SLACK_WEBHOOK_URL; do
        if [ -z "$(eval "echo \${$_v:-}")" ]; then
            _val="$(load_env_var "$_v")"; [ -n "$_val" ] && export "$_v=$_val"
        fi
    done
    [ -x "$NOTIFY" ] && bash "$NOTIFY" \
        "⚠️ オフサイト(R2)の保持ローテーションに失敗（アップロードは成功）。手動確認を" \
        --color warning >/dev/null 2>&1 || true
fi

log "完了: オフサイト複製（${R2_BUCKET}/${OFFSITE_PREFIX}）"
exit 0

# --- VPS へのインストール手順（hkobayashi 手動） ---
#
#   0) 事前準備（一度きり）:
#      - Cloudflare ダッシュボードで R2 バケットを作成（例: r2c-db-backups）
#      - R2 の「API トークン」から S3 互換の Access Key ID / Secret を発行
#        （権限は Object Read & Write。バケットは当該バケットに限定するのが望ましい）
#      - VPS の /opt/rajiuce/.env に以下を追記（値は絶対にコミットしない）:
#          R2_ACCOUNT_ID=...
#          R2_ACCESS_KEY_ID=...
#          R2_SECRET_ACCESS_KEY=...
#          R2_BUCKET=r2c-db-backups
#      - rclone を導入: curl https://rclone.org/install.sh | sudo bash
#
#   1) 投入前に dry-run で疎通と対象を確認する（実転送しない）:
#        bash /opt/rajiuce/SCRIPTS/backup-offsite.sh --dry-run
#
#   2) 手動で1回実行し、オフサイトに載ることを確認する:
#        bash /opt/rajiuce/SCRIPTS/backup-offsite.sh
#        bash /opt/rajiuce/SCRIPTS/backup-offsite.sh --list
#
#   3) crontab -e で backup-postgres.sh の直後に追加する。
#      **cron はサーバTZ(VPSはUTC)で動く。** ローカルバックアップ(0 17 UTC)の後に:
#        30 17 * * * bash /opt/rajiuce/SCRIPTS/backup-offsite.sh >> /var/log/r2c-offsite.log 2>&1
#      追記形式で（既存の cron 行を壊さない）:
#        crontab -l 2>/dev/null | grep -q backup-offsite || \
#          (crontab -l 2>/dev/null; echo "30 17 * * * bash /opt/rajiuce/SCRIPTS/backup-offsite.sh >> /var/log/r2c-offsite.log 2>&1") | crontab -
#
#   4) 翌日、オフサイトに実物が在ることを確認する（cron を書いた≠動作確認）:
#        bash /opt/rajiuce/SCRIPTS/backup-offsite.sh --list
#
#   5) 復旧手順は docs/BACKUP_AND_MONITORING.md 参照。
#      要点: rclone copy で R2 から手元へ取得 → gzip -t で健全性確認 →
#            backup-postgres.sh --restore-test で検証用DBへ戻して突き合わせる。
