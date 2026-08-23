#!/usr/bin/env bash
# check-groq-models-live.test.sh — check-groq-models-live.sh の判定を固定する
#
# なぜ必要か:
#   このスクリプトが防ぎたいのは「Groq が黙ってモデルを消し、本番が止まるまで誰も気づかない」こと。
#   実際 2026-08 に llama-3.3-70b-versatile / llama-3.1-8b-instant が消え、
#   手動リスト頼みの既存検知層（check-groq-models.sh）は素通りしてアバターチャットが停止した。
#   したがって最も重要なのは 2 点:
#     1) 廃止を検知したら必ず非ゼロで落ちること（見逃さない）
#     2) 検知できなかっただけの時に落ちないこと（オオカミ少年にしない＝1と2を混同しない）
#   正常系より、この 2 つの区別を厚く見る。
#
# 実行: bash SCRIPTS/check-groq-models-live.test.sh
# 本物の Groq API には一切触らない（GROQ_MODELS_URL をローカルのモックへ差し替える）。

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/check-groq-models-live.sh"
PASS=0; FAIL=0

WORK="$(mktemp -d)"
MOCK_PID=""
cleanup() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

check() {  # $1: 説明, $2: 実際, $3: 期待
  if [[ "$2" == "$3" ]]; then
    echo "  PASS: $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 — expected='$3' actual='$2'"
    FAIL=$((FAIL + 1))
  fi
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 が無いためテストをスキップします" >&2
  exit 0
fi

# --- 検査対象のカタログを WORK に作る（本物の src/ には触らない） --------------
mk_catalog() {  # $1: ACTIVE に入れる実 ID を空白区切りで
  mkdir -p "${WORK}/src/config" "${WORK}/src/agent"
  {
    echo "// test catalog"
    local i=0
    for id in $1; do
      echo "export const TEST_MODEL_${i} = '${id}';"
      i=$((i + 1))
    done
    echo "export const ACTIVE_GROQ_MODELS: readonly GroqModelEntry[] = ["
    i=0
    for _ in $1; do
      echo "  { id: TEST_MODEL_${i}, tier: 'instant', status: 'active' },"
      i=$((i + 1))
    done
    echo "] as const;"
  } > "${WORK}/src/config/groqModels.ts"
  # SCRIPTS/.. を ROOT とみなすため、対象スクリプトを WORK/SCRIPTS へ複製する
  mkdir -p "${WORK}/SCRIPTS"
  cp "$TARGET" "${WORK}/SCRIPTS/"
}

# --- モック HTTP サーバ（/v1/models を返す） ----------------------------------
PORT=8793
start_mock() {  # $1: 返す JSON, $2: HTTP ステータス
  local body="$1" code="${2:-200}"
  printf '%s' "$body" > "${WORK}/mock_body.json"
  printf '%s' "$code" > "${WORK}/mock_code"
  python3 - "$WORK" "$PORT" <<'PY' &
import http.server, socketserver, sys
work, port = sys.argv[1], int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        code = int(open(f"{work}/mock_code").read().strip())
        b = open(f"{work}/mock_body.json", "rb").read()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), H) as s:
    s.serve_forever()
PY
  MOCK_PID=$!
  sleep 1.2
}
stop_mock() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  wait "$MOCK_PID" 2>/dev/null
  MOCK_PID=""
}

run() {  # モック URL を向けて対象を実行し、終了コードを返す
  GROQ_API_KEY=dummy-not-a-real-key \
  GROQ_MODELS_URL="http://127.0.0.1:${PORT}/v1/models" \
  ENV_FILE=/nonexistent \
  bash "${WORK}/SCRIPTS/check-groq-models-live.sh" > "${WORK}/out.txt" 2>&1
}

LIVE_3='{"object":"list","data":[{"id":"groq/compound"},{"id":"openai/gpt-oss-20b"},{"id":"openai/gpt-oss-120b"}]}'

echo "== 1. カタログの全 ID が生存 → PASS(0) =="
mk_catalog "groq/compound openai/gpt-oss-120b"
start_mock "$LIVE_3"
run; rc=$?
stop_mock
check "ゼロで終了する" "$rc" "0"
check "PASS と表示する" "$(grep -c 'PASS —' "${WORK}/out.txt")" "1"

echo "== 2. 廃止モデルを保持 → FAIL(1) かつ ID を名指しする =="
mk_catalog "groq/compound llama-3.3-70b-versatile"
start_mock "$LIVE_3"
run; rc=$?
stop_mock
check "1 で終了する（検知失敗の 2 と区別）" "$rc" "1"
check "廃止 ID を名指しする" "$(grep -c 'llama-3.3-70b-versatile' "${WORK}/out.txt")" "1"
check "生存 ID は名指ししない" "$(grep -c '✗ groq/compound' "${WORK}/out.txt")" "0"

echo "== 3. Groq にあるがカタログ未登録 → 情報のみ・落とさない =="
mk_catalog "groq/compound"
start_mock "$LIVE_3"
run; rc=$?
stop_mock
check "ゼロで終了する" "$rc" "0"
check "INFO として出す" "$(grep -c 'INFO —' "${WORK}/out.txt")" "1"

echo "== 4. API が 401 → SKIP(2)。FAIL(1) にしない =="
mk_catalog "groq/compound llama-3.3-70b-versatile"
start_mock '{"error":{"message":"Invalid API Key"}}' 401
run; rc=$?
stop_mock
check "2 で終了する" "$rc" "2"
check "廃止として報告しない" "$(grep -c 'DECOMMISSIONED' "${WORK}/out.txt")" "0"

echo "== 5. API へ到達不能 → SKIP(2) =="
mk_catalog "groq/compound llama-3.3-70b-versatile"
run; rc=$?   # モックを起動しない
check "2 で終了する" "$rc" "2"
check "廃止として報告しない" "$(grep -c 'DECOMMISSIONED' "${WORK}/out.txt")" "0"

echo "== 6. レスポンスが壊れている → SKIP(2) =="
mk_catalog "groq/compound"
start_mock 'not-json-at-all'
run; rc=$?
stop_mock
check "2 で終了する" "$rc" "2"

echo "== 7. data が空配列 → SKIP(2)。全件廃止と誤判定しない =="
mk_catalog "groq/compound llama-3.3-70b-versatile"
start_mock '{"object":"list","data":[]}'
run; rc=$?
stop_mock
check "2 で終了する" "$rc" "2"
check "廃止として報告しない" "$(grep -c 'DECOMMISSIONED' "${WORK}/out.txt")" "0"

echo "== 8. API キーを出力に一切出さない =="
mk_catalog "groq/compound llama-3.3-70b-versatile"
start_mock "$LIVE_3"
run; rc=$?
stop_mock
check "キー文字列が出力に無い" "$(grep -c 'dummy-not-a-real-key' "${WORK}/out.txt")" "0"

echo "== 9. キー未設定 → SKIP(2)。FAIL(1) にしない =="
mk_catalog "groq/compound llama-3.3-70b-versatile"
start_mock "$LIVE_3"
env -u GROQ_API_KEY GROQ_MODELS_URL="http://127.0.0.1:${PORT}/v1/models" ENV_FILE=/nonexistent \
  bash "${WORK}/SCRIPTS/check-groq-models-live.sh" > "${WORK}/out.txt" 2>&1
rc=$?
stop_mock
check "2 で終了する" "$rc" "2"
check "廃止として報告しない" "$(grep -c 'DECOMMISSIONED' "${WORK}/out.txt")" "0"

echo ""
echo "PASS=${PASS} FAIL=${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
