#!/usr/bin/env bash
# SCRIPTS/check-groq-models-live.sh
# EOL 検知層（ライブ照合）: Groq の /v1/models が返す「実際に配信中のモデル」と
# src/config/groqModels.ts#ACTIVE_GROQ_MODELS を突き合わせ、
# **コードがアクティブだと思っているのに Groq には存在しない** ID を検出する。
#
# なぜ必要か:
#   姉妹スクリプト check-groq-models.sh は KNOWN_DEPRECATED_GROQ_MODELS（手動メンテのリスト）
#   に載った ID しか検知できない。2026-08 に Groq が llama-3.3-70b-versatile /
#   llama-3.1-8b-instant を廃止した際、誰もリストに追記しなかったため検知層は素通りし、
#   アバターチャットが本番で全面停止した。告知の見落としがそのまま障害になる構造だった。
#   このスクリプトは「Groq が今どれを配信しているか」を直接見るので、告知を見落としても気づける。
#
# 使い方:
#   GROQ_API_KEY=... bash SCRIPTS/check-groq-models-live.sh
#   ENV_FILE=/opt/rajiuce/.env bash SCRIPTS/check-groq-models-live.sh   # VPS 上
#
# 設計上の約束:
#   - .env を source しない。プレースホルダ（KEY=<...> 等）がリダイレクトと解釈され、
#     前後の行がコマンドとして実行されてシークレットが露出する（2026-08-08 に実際に起きた）。
#     必要な1行だけ sed で取り出す（backup-postgres.sh / monitor-avatar-agent.sh と同じ作法）。
#   - API キーを標準出力・標準エラー・ログに一切出さない。
#   - 「廃止を検知した(1)」と「検知そのものに失敗した(2)」を終了コードで区別する。
#     後者で赤くするとオオカミ少年になり、本当の廃止を見落とすため。
#
# 終了コード:
#   0 = PASS       ACTIVE_GROQ_MODELS の全 ID が Groq に存在する
#   1 = FAIL       Groq に存在しない ID がある（＝要移行。本番停止の予兆）
#   2 = SKIP/ERROR 検知不能（キー未設定 / API 到達不可 / パース失敗）。CI を赤くしないこと。
#
# CI 非採用の理由:
#   GROQ_API_KEY は GitHub Actions の secret に存在しない（2026-08 時点で登録済みなのは
#   CLOUDFLARE_API_TOKEN / E2E_TEST_* / SLACK_WEBHOOK_URL_R2C / TEST_* / VITE_SUPABASE_* のみ）。
#   また Groq 側の一時障害やレート制限で PR の CI が落ちると開発が止まるため、
#   ネットワーク依存の検査を PR ごとのゲートに入れない方針。運用者が手動 / cron で回す。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CATALOG="$ROOT/src/config/groqModels.ts"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
GROQ_MODELS_URL="${GROQ_MODELS_URL:-https://api.groq.com/openai/v1/models}"
CURL_TIMEOUT="${CURL_TIMEOUT:-25}"

EXIT_PASS=0
EXIT_FAIL=1
EXIT_SKIP=2

if [[ ! -f "$CATALOG" ]]; then
  echo "[check-groq-models-live] catalog not found: $CATALOG" >&2
  exit "$EXIT_SKIP"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[check-groq-models-live] SKIP — python3 not available (JSON パースに必要)" >&2
  exit "$EXIT_SKIP"
fi

# --- API キーの取得（source しない。値は一切表示しない） ---------------------
load_env_var() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^"//; s/"$//' | tr -d '\r'
}

API_KEY="${GROQ_API_KEY:-}"
if [[ -z "$API_KEY" ]]; then
  API_KEY="$(load_env_var GROQ_API_KEY)"
fi
if [[ -z "$API_KEY" ]]; then
  echo "[check-groq-models-live] SKIP — GROQ_API_KEY 未設定（env / $ENV_FILE のいずれにも無い）"
  echo "  実行例: GROQ_API_KEY=... bash SCRIPTS/check-groq-models-live.sh"
  exit "$EXIT_SKIP"
fi

# --- カタログから ACTIVE_GROQ_MODELS の実 ID を解決する -----------------------
# ACTIVE 配列は `{ id: GROQ_INSTANT_8B, ... }` のように**定数名**を参照しているため、
# 先に `export const NAME = 'value';` を集めて名前→実 ID を引けるようにする。
CONST_MAP="$(grep -oE "^export const [A-Z0-9_]+ = '[^']+';" "$CATALOG" \
  | sed -E "s/^export const ([A-Z0-9_]+) = '([^']+)';$/\1 \2/")"

# ACTIVE_GROQ_MODELS ブロック内の `id: XXX,` から定数名を抜く。
# 宣言行は次行から走査し、終端は単独の `] as const` 行（既存 check-groq-models.sh と同じ判定）。
ACTIVE_CONST_NAMES="$(awk '/ACTIVE_GROQ_MODELS/{f=1; next} f && /^\] as const/{f=0} f' "$CATALOG" \
  | grep -oE "id: [A-Z0-9_]+" | sed 's/^id: //')"

if [[ -z "$ACTIVE_CONST_NAMES" ]]; then
  echo "[check-groq-models-live] SKIP — ACTIVE_GROQ_MODELS を解釈できなかった（カタログの書式変更？）" >&2
  exit "$EXIT_SKIP"
fi

ACTIVE_IDS=()
UNRESOLVED=()
while IFS= read -r cname; do
  [[ -n "$cname" ]] || continue
  cid="$(printf '%s\n' "$CONST_MAP" | awk -v n="$cname" '$1 == n { print $2; exit }')"
  if [[ -z "$cid" ]]; then
    UNRESOLVED+=("$cname")
  else
    ACTIVE_IDS+=("$cid")
  fi
done <<< "$ACTIVE_CONST_NAMES"

if [[ ${#UNRESOLVED[@]} -gt 0 ]]; then
  echo "[check-groq-models-live] SKIP — 定数を実 ID に解決できませんでした: ${UNRESOLVED[*]}" >&2
  exit "$EXIT_SKIP"
fi

echo "[check-groq-models-live] catalog ACTIVE_GROQ_MODELS: ${#ACTIVE_IDS[@]} ids"

# --- Groq /v1/models を取得（キーはヘッダにのみ渡す。出力しない） -------------
HTTP_BODY_FILE="$(mktemp)"
# shellcheck disable=SC2064
trap "rm -f '$HTTP_BODY_FILE'" EXIT

HTTP_CODE="$(curl -sS --max-time "$CURL_TIMEOUT" \
  -o "$HTTP_BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer ${API_KEY}" \
  "$GROQ_MODELS_URL" 2>/dev/null || echo '000')"

if [[ "$HTTP_CODE" == "000" ]]; then
  echo "[check-groq-models-live] SKIP — Groq API へ到達できませんでした（ネットワーク / タイムアウト）" >&2
  exit "$EXIT_SKIP"
fi
if [[ "$HTTP_CODE" != "200" ]]; then
  # 401/429 等。本文にキーは含まれないが、念のため先頭のみ・短く出す。
  echo "[check-groq-models-live] SKIP — Groq API が HTTP $HTTP_CODE を返しました（認証切れ / レート制限の可能性）" >&2
  head -c 200 "$HTTP_BODY_FILE" >&2 || true
  echo "" >&2
  exit "$EXIT_SKIP"
fi

LIVE_IDS="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(3)
data = d.get("data")
if not isinstance(data, list) or not data:
    sys.exit(3)
for m in data:
    i = m.get("id")
    if i:
        print(i)
' "$HTTP_BODY_FILE")"
PY_STATUS=$?

if [[ $PY_STATUS -ne 0 || -z "$LIVE_IDS" ]]; then
  echo "[check-groq-models-live] SKIP — /v1/models のレスポンスを解釈できませんでした" >&2
  exit "$EXIT_SKIP"
fi

LIVE_COUNT="$(printf '%s\n' "$LIVE_IDS" | grep -c . || true)"
echo "[check-groq-models-live] Groq live models: $LIVE_COUNT ids"
echo ""

# --- 突き合わせ ---------------------------------------------------------------
# (a) カタログにあるが Groq に無い = 廃止済み → FAIL（本番停止の予兆）
MISSING=()
for id in "${ACTIVE_IDS[@]}"; do
  if ! printf '%s\n' "$LIVE_IDS" | grep -qxF "$id"; then
    MISSING+=("$id")
  fi
done

# (b) Groq にあるがカタログが知らない = 新モデル → 情報のみ（失敗にしない）
UNKNOWN=()
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  known=0
  for a in "${ACTIVE_IDS[@]}"; do
    [[ "$a" == "$id" ]] && { known=1; break; }
  done
  [[ $known -eq 0 ]] && UNKNOWN+=("$id")
done <<< "$LIVE_IDS"

if [[ ${#UNKNOWN[@]} -gt 0 ]]; then
  echo "[check-groq-models-live] INFO — Groq にあるがカタログ未登録（採用検討の候補。失敗ではない）:"
  for id in "${UNKNOWN[@]}"; do echo "    + $id"; done
  echo ""
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "----- DECOMMISSIONED BY GROQ (ACTIVE_GROQ_MODELS に定義されているが Groq に存在しない) -----"
  for id in "${MISSING[@]}"; do
    echo "  ✗ $id"
    # そのモデルを参照している src/ の箇所を出して移行対象を名指しする。
    HITS="$(grep -rn --include='*.ts' -F "$id" "$ROOT/src" 2>/dev/null \
      | grep -v '\.test\.ts' \
      | grep -v 'src/config/groqModels.ts' || true)"
    if [[ -n "$HITS" ]]; then
      printf '%s\n' "$HITS" | sed 's/^/      /'
    else
      echo "      (src/ に直接の参照なし — カタログ定義のみ)"
    fi
  done
  echo ""
  echo "[check-groq-models-live] FAIL — Groq が配信していないモデルを ACTIVE として保持しています。"
  echo "  対応: 1) 生存モデルへ移行  2) 旧 ID を KNOWN_DEPRECATED_GROQ_MODELS へ追記"
  echo "        3) GROQ_FALLBACK_CHAIN の退避先が生存モデルを指しているか確認"
  exit "$EXIT_FAIL"
fi

echo "[check-groq-models-live] PASS — ACTIVE_GROQ_MODELS の全 ID が Groq に存在します。"
exit "$EXIT_PASS"
