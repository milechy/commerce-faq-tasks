#!/usr/bin/env bash
# monitor-avatar-agent.sh — avatar-agent の致命的エラーを検知して Slack 通知する
#
# なぜ必要か:
#   2026-07-30〜2026-08-08 の約9日間、PyAV のインストール破損で TTS が起動直後に落ち、
#   アバターの音声が出ず起動から約10秒で消える状態が続いた。エラーは pm2 のログに
#   出続けていたが、誰も読んでいなかったため9日間検知されなかった。
#   ログに出ているだけでは検知にならない、というのが唯一の教訓。
#
# 実行場所: VPS（ログがあるのはここ。ローカルの monitor-claude-health.sh は
#           $HOME 配下しか見ておらず、VPS のログには到達できない）
# 実行間隔: cron で 10 分毎を想定（インストール手順は下部を参照）
#
# 設計上の約束:
#   - ログ本文を Slack に送らない。会話内容・PII が混ざるため（CLAUDE.md Anti-Slop）。
#     送るのは「どの症状が」「何件」「いつ」までで、中身は人間が VPS で確認する。
#   - 前回読んだ位置から先だけを見る。毎回全部読むと同じエラーを延々通知してしまう。
#   - 同じ症状は既定 6h 抑止する。復旧したかどうかは人間が判断する。
#
# 使い方:
#   bash SCRIPTS/monitor-avatar-agent.sh            # 通常実行
#   bash SCRIPTS/monitor-avatar-agent.sh --dry-run  # 通知せず検知結果だけ表示
#   LOG_DIR=/path/to/logs bash SCRIPTS/monitor-avatar-agent.sh --dry-run  # テスト用
#
# 関連: docs/AVATAR_CONFIG_500_RECOVERY.md（症状と復旧手順）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-/root/.pm2/logs}"
STATE_DIR="${STATE_DIR:-/var/lib/r2c-monitor}"
OFFSET_FILE="${STATE_DIR}/avatar-agent-offsets"
THROTTLE_FILE="${STATE_DIR}/avatar-agent-throttle"
THROTTLE_SECONDS="${THROTTLE_SECONDS:-21600}"   # 6h
NOTIFY="${SCRIPT_DIR}/notify-slack.sh"

ENV_FILE="${ENV_FILE:-/opt/rajiuce/.env}"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Slack 資格情報の読み込み。
#
# notify-slack.sh は $HOME/.claude-r2c-config/secrets/r2c-loop.env から秘匿値を読むが、
# あれはローカル Mac の 24h ループ用のパスで VPS には存在しない。さらに cron は
# 最小環境で起動するため、VPS の .env も自動では読まれない。
# その状態で notify-slack.sh を呼ぶと、エラーも出さずに黙って何もしないまま終わる
# （実際に踏んだ。「監視は動いているが通知だけ届かない」という、この監視が
#   防ごうとしている状況そのものになる）。
# ここで必要な変数だけを明示的に取り出して export する。
#
# .env を source しないこと。プレースホルダ（FAL_KEY=<...> 等）が
# リダイレクトと解釈されて構文エラーになるうえ、前後の行がコマンドとして実行され
# API キーが端末に露出する（2026-08-08 に実際に起きた）。
load_env_var() {
    [ -f "$ENV_FILE" ] || return 0
    sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^"//; s/"$//'
}
for _v in SLACK_BOT_TOKEN SLACK_WEBHOOK_URL_R2C SLACK_WEBHOOK_URL; do
    if [ -z "$(eval "echo \${$_v:-}")" ]; then
        _val="$(load_env_var "$_v")"
        [ -n "$_val" ] && export "$_v=$_val"
    fi
done
unset _v _val

# 通知経路が無いなら、それ自体を異常として扱う。
# 黙って通知できないままにすると、監視があるという理由で余計に気づけなくなる。
has_notify_channel() {
    [ -n "${SLACK_BOT_TOKEN:-}" ] || [ -n "${SLACK_WEBHOOK_URL_R2C:-}" ] || [ -n "${SLACK_WEBHOOK_URL:-}" ]
}

mkdir -p "$STATE_DIR" 2>/dev/null || true
touch "$OFFSET_FILE" "$THROTTLE_FILE" 2>/dev/null || true

now() { date +%s; }

# 検知する症状。
#   キー|正規表現|人間向けの説明
# 追加するときは「これが出たら実際にユーザー影響がある」ものだけにすること。
# 警告レベルのノイズを入れると、また誰も読まなくなる。
PATTERNS=(
"pyav_broken|module 'av' has no attribute|PyAV が壊れています。音声が出ず、アバターが約10秒で消えます"
"module_missing|ModuleNotFoundError|Python パッケージが欠落しています。エージェントが起動できません"
"audio_decode|error decoding audio|音声デコードに失敗しています。TTS が動いていません"
"avatar_start_failed|Lemonslice avatar failed|アバターの起動に失敗しました（テキストのみで継続中）"
"identity_unresolved|アバターを起動しません|アバター設定を解決できず、意図的に起動を見送りました"
)

# 前回位置の取得・保存（ログローテーションでファイルが縮んだら 0 に戻す）
get_offset() { grep -- "^$1 " "$OFFSET_FILE" 2>/dev/null | tail -1 | awk '{print $2}'; }
set_offset() {
    local f="$1" off="$2" tmp
    tmp="$(mktemp)"
    grep -v -- "^$f " "$OFFSET_FILE" 2>/dev/null > "$tmp" || true
    echo "$f $off" >> "$tmp"
    mv "$tmp" "$OFFSET_FILE"
}

throttled() {
    local key="$1" last
    last=$(grep -- "^$key " "$THROTTLE_FILE" 2>/dev/null | tail -1 | awk '{print $2}')
    [ -z "$last" ] && return 1
    [ "$(( $(now) - last ))" -lt "$THROTTLE_SECONDS" ]
}

mark_throttle() {
    local key="$1" tmp
    tmp="$(mktemp)"
    grep -v -- "^$key " "$THROTTLE_FILE" 2>/dev/null > "$tmp" || true
    echo "$key $(now)" >> "$tmp"
    mv "$tmp" "$THROTTLE_FILE"
}

# 新規行だけを取り出す
new_lines=""
shopt -s nullglob
for logfile in "$LOG_DIR"/rajiuce-avatar-*.log; do
    size=$(wc -c < "$logfile" 2>/dev/null || echo 0)
    prev=$(get_offset "$logfile")
    prev=${prev:-0}
    # ローテーションで縮んだら読み直す
    [ "$size" -lt "$prev" ] && prev=0
    if [ "$size" -gt "$prev" ]; then
        chunk=$(tail -c "+$((prev + 1))" "$logfile" 2>/dev/null || true)
        new_lines+="$chunk"$'\n'
    fi
    set_offset "$logfile" "$size"
done
shopt -u nullglob

if [ -z "${new_lines//[$'\n\t ']/}" ]; then
    echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] 新規ログなし"
    exit 0
fi

found=0
for entry in "${PATTERNS[@]}"; do
    key="${entry%%|*}"
    rest="${entry#*|}"
    regex="${rest%%|*}"
    desc="${rest#*|}"

    count=$(printf '%s' "$new_lines" | grep -c -- "$regex" 2>/dev/null || true)
    count=${count:-0}
    [ "$count" -eq 0 ] && continue
    found=1

    if throttled "$key"; then
        echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $key: ${count}件（抑止中のため通知しない）"
        continue
    fi

    # ログ本文は載せない（会話内容・PII が混ざるため）。件数と対処先だけ送る。
    msg="🛑 avatar-agent: ${desc}（直近 ${count} 件）"
    msg+=$'\n'"確認: pm2 logs rajiuce-avatar --lines 200 --nostream | grep -E \"${regex}\""
    msg+=$'\n'"復旧手順: docs/AVATAR_CONFIG_500_RECOVERY.md"

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] DRY-RUN 通知: $key (${count}件)"
        echo "$msg" | sed 's/^/    /'
    elif [ ! -x "$NOTIFY" ]; then
        echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] 通知不可: notify-slack.sh が見つかりません ($NOTIFY): $key (${count}件)" >&2
        notify_broken=1
    elif ! has_notify_channel; then
        # 資格情報が無いと notify-slack.sh は何も言わずに終わる。ここで先に止めて明示する。
        echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] 通知不可: Slack の資格情報がありません" >&2
        echo "  $key を ${count} 件検知しましたが通知できません。" >&2
        echo "  ${ENV_FILE} に SLACK_WEBHOOK_URL / SLACK_WEBHOOK_URL_R2C / SLACK_BOT_TOKEN のいずれかを設定してください。" >&2
        notify_broken=1
    else
        "$NOTIFY" "$msg" --color error --alert-type "avatar_${key}" >/dev/null 2>&1 \
            && echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] 通知しました: $key (${count}件)" \
            || { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] 通知に失敗: $key (${count}件)" >&2; notify_broken=1; }
        mark_throttle "$key"
    fi
done

if [ "$found" -eq 0 ]; then
    echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] 異常なし"
    # 平常時こそ通知経路の生死を確かめておく。異常が起きてから
    # 「実は通知できませんでした」では手遅れになる。
    if [ "$DRY_RUN" -eq 0 ] && ! has_notify_channel; then
        echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] 警告: Slack の資格情報が無いため、異常を検知しても通知できません" >&2
        exit 2
    fi
fi

# 検知したのに通知できなかった場合は非ゼロで終わる。cron のログと終了コードに痕跡を残す。
[ "${notify_broken:-0}" -eq 1 ] && exit 2
exit 0

# --- VPS へのインストール手順（hkobayashi 手動） ---
#
#   crontab -e で以下を追加（10分毎）:
#     */10 * * * * bash /opt/rajiuce/SCRIPTS/monitor-avatar-agent.sh >> /var/log/r2c-avatar-monitor.log 2>&1
#
#   Slack 通知には notify-slack.sh が読む環境変数が必要:
#     SLACK_BOT_TOKEN もしくは SLACK_WEBHOOK_URL_R2C
#
#   投入前に必ず dry-run で確認すること:
#     bash /opt/rajiuce/SCRIPTS/monitor-avatar-agent.sh --dry-run
