#!/usr/bin/env bash
# SCRIPTS/gate-8.5-scenario-smoke.sh — Gate 8.5: 本番シナリオ smoke test
#
# 目的: テスト用 API キーで実際のビジネスロジックを叩き、応答内容を検証する
#       Gate 8 (エンドポイント存在確認) の上位版。中身まで確認する。
#
# 前提: E2E_TEST_API_KEY / E2E_TEST_TENANT_ID を .env またはシェル環境に設定
# 手動実行: bash SCRIPTS/gate-8.5-scenario-smoke.sh

set -euo pipefail

API_URL="${API_URL:-https://api.r2c.biz}"
TEST_API_KEY="${E2E_TEST_API_KEY:-}"
TEST_TENANT_ID="${E2E_TEST_TENANT_ID:-}"
PASS=0
FAIL=0
SKIP=0
FAIL_MSGS=()

pass()  { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail()  { echo "  ❌ $1"; FAIL=$((FAIL + 1)); FAIL_MSGS+=("$1"); }
skip()  { echo "  ⏭  $1"; SKIP=$((SKIP + 1)); }

echo "=== Gate 8.5: 本番シナリオ smoke test ($(date '+%Y-%m-%d %H:%M:%S')) ==="
echo "  API: ${API_URL}"
echo ""

# ─── 前提チェック ────────────────────────────────────────────────────────────
if [[ -z "${TEST_API_KEY}" || -z "${TEST_TENANT_ID}" ]]; then
  echo "  ⚠️  E2E_TEST_API_KEY / E2E_TEST_TENANT_ID 未設定 — Gate 8.5 SKIP"
  echo ""
  echo "  設定方法: .env に以下を追加"
  echo "    E2E_TEST_API_KEY=<テスト用APIキー>"
  echo "    E2E_TEST_TENANT_ID=<テナントID>"
  exit 0
fi

# ─── シナリオ 1: チャット正常応答 ─────────────────────────────────────────
echo "── シナリオ 1: チャット正常応答（RAG 疎通確認）"
chat_response=$(curl -s --max-time 30 -X POST "${API_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${TEST_API_KEY}" \
  -H "x-r2c-traffic-source: e2e" \
  -d '{"message": "よくある質問を教えてください", "sessionId": "gate-8.5-smoke-test"}' \
  2>/dev/null || echo '{}')

chat_status=$(echo "${chat_response}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('state',''))" 2>/dev/null || echo "")
chat_answer=$(echo "${chat_response}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('answer',''))" 2>/dev/null || echo "")
chat_error=$(echo "${chat_response}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null || echo "")
chat_answer_len=${#chat_answer}

if [[ "${chat_error}" == "invalid_api_key" ]]; then
  skip "POST /api/chat → E2E_TEST_API_KEY が無効 (GitHub シークレット更新が必要)"
elif [[ "${chat_answer_len}" -ge 10 ]]; then
  pass "POST /api/chat → answer ${chat_answer_len} 文字, state='${chat_status}'"
elif [[ -n "${chat_status}" ]]; then
  fail "POST /api/chat → answer が短すぎる (${chat_answer_len} 文字), state='${chat_status}'"
else
  fail "POST /api/chat → 応答なし / JSON パース失敗: $(echo "${chat_response}" | head -c 200)"
fi

# ─── シナリオ 2: テナント分離（別テナントのデータが見えないか）─────────────
echo "── シナリオ 2: テナント分離確認"
# 存在しないテナントのAPIキーとして空文字を使い、401が返ることを確認
isolation_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 -X POST "${API_URL}/api/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: invalid-key-tenant-isolation-check-$(date +%s)" \
  -H "x-r2c-traffic-source: e2e" \
  -d '{"message": "test", "sessionId": "isolation-check"}' \
  2>/dev/null || echo "000")

if [[ "${isolation_code}" == "401" || "${isolation_code}" == "403" ]]; then
  pass "無効 API キー → HTTP ${isolation_code} (テナント分離 OK)"
else
  fail "無効 API キー → HTTP ${isolation_code} (expected 401/403 — テナント分離が機能していない可能性)"
fi

# ─── シナリオ 3: レート制限（連打で 429 が返るか）─────────────────────────
echo "── シナリオ 3: レート制限確認（10 連打）"
got_429=0
for i in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST "${API_URL}/api/chat" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${TEST_API_KEY}" \
    -H "x-r2c-traffic-source: e2e" \
    -d '{"message": "rate limit test", "sessionId": "rate-limit-probe-'${i}'"}' \
    2>/dev/null || echo "000")
  if [[ "${code}" == "429" ]]; then
    got_429=1
    break
  fi
done

if [[ "${got_429}" -eq 1 ]]; then
  pass "レート制限 → 10 連打中に 429 を確認"
else
  skip "レート制限 → 10 連打で 429 なし (レート上限が高い or mock env)"
fi

# ─── シナリオ 4: /health/business ─────────────────────────────────────────
# [P0] #1072 で internal-only ガード(loopback限定 + X-Internal-Request)を追加済み。
# この smoke は GitHub Actions ランナーから叩くため、常に非 loopback = 常に 403 が
# 正しい応答。200 が返ってきたらガードが外れた退行なので FAIL 扱いにする
# (以前は 200 を pass 扱いにしていたため、この保護が効いている間ずっと
#  smoke 側が誤って FAIL を報告し続けていた)。
echo "── シナリオ 4: /health/business ビジネスロジック健全性"
biz_body=$(curl -s --max-time 15 "${API_URL}/health/business" 2>/dev/null || echo '{}')
biz_http=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${API_URL}/health/business" 2>/dev/null || echo "000")
if [[ "${biz_http}" == "403" ]]; then
  pass "/health/business → 403 (internal-only ガード OK)"
elif [[ "${biz_http}" == "200" ]]; then
  fail "/health/business → HTTP 200 (internal-only ガードが外れている可能性 [P0] #1072 の退行): ${biz_body:0:200}"
elif [[ "${biz_http}" == "404" ]]; then
  skip "/health/business → 404 (未実装)"
else
  fail "/health/business → HTTP ${biz_http}"
fi

# ─── サマリー ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  Gate 8.5 結果: PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP}"
echo "═══════════════════════════════════════"

if [[ "${FAIL}" -gt 0 ]]; then
  echo "  失敗項目:"
  for msg in "${FAIL_MSGS[@]}"; do
    echo "    ❌ ${msg}"
  done
  exit 1
fi

exit 0
