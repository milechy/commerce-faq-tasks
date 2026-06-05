#!/usr/bin/env bash
# SCRIPTS/gate-8-integration-smoke.sh — Gate 8: 統合 smoke test (Phase70-J)
#
# 目的: 並列 merge 後の統合状態を 3-5 分で検証する
# 実行タイミング: main push 時 (GitHub Actions gate-8-post-merge.yml)
# 手動実行:  bash SCRIPTS/gate-8-integration-smoke.sh
#
# 終了コード: 0=全 PASS, 1=1 件以上 FAIL

set -euo pipefail

API_URL="${API_URL:-https://api.r2c.biz}"
PASS=0
FAIL=0
FAIL_MSGS=()

# ─────────────────────────────────────────────────────────────────────────────
pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); FAIL_MSGS+=("$1"); }
http_status() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$1" 2>/dev/null || echo "000"
}

http_post_status() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 15 -X POST \
    -H "Content-Type: application/json" -d '{}' "$1" 2>/dev/null || echo "000"
}

echo "=== Gate 8: 統合 smoke test ($(date '+%Y-%m-%d %H:%M:%S')) ==="
echo "  API: ${API_URL}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# A. /health — 基本死活確認
# ─────────────────────────────────────────────────────────────────────────────
echo "── A. /health 確認"
health_body=$(curl -s --max-time 15 "${API_URL}/health" 2>/dev/null || echo '{}')
health_status=$(echo "${health_body}" | jq -r '.status // empty' 2>/dev/null || echo "")

if [[ "${health_status}" == "ok" ]]; then
  pass "/health → status=ok"
else
  fail "/health → status='${health_status}' (expected 'ok')"
fi

# ─────────────────────────────────────────────────────────────────────────────
# B. /health/business — ビジネスロジック健全性 (タスク 1214955323125956 完了後有効)
# ─────────────────────────────────────────────────────────────────────────────
echo "── B. /health/business 確認"
biz_code=$(http_status "${API_URL}/health/business")
if [[ "${biz_code}" == "200" ]]; then
  biz_body=$(curl -s --max-time 15 "${API_URL}/health/business" 2>/dev/null || echo '{}')
  warnings=$(echo "${biz_body}" | jq -r '.warnings | length' 2>/dev/null || echo "0")
  if [[ "${warnings:-0}" -gt 0 ]]; then
    warn_list=$(echo "${biz_body}" | jq -r '.warnings[]' 2>/dev/null | head -3 | tr '\n' '; ')
    messages_24h=$(echo "${biz_body}" | jq -r '.chat_messages_24h // 0' 2>/dev/null || echo "0")
    if [[ "${messages_24h}" -eq 0 ]]; then
      # chat_messages_24h=0 → 非稼働期間の誤警告 (PR #303 修正が未デプロイの場合も含む)
      echo "  ⏭  /health/business → warnings=${warnings} ただし chat_messages_24h=0 (非稼働期間 SKIP): ${warn_list}"
    else
      fail "/health/business → warnings=${warnings}: ${warn_list}"
    fi
  else
    pass "/health/business → 200, warnings=0"
  fi
elif [[ "${biz_code}" == "404" ]]; then
  # エンドポイント未実装時は SKIP
  echo "  ⏭  /health/business → 404 SKIP (エンドポイント未実装)"
else
  fail "/health/business → HTTP ${biz_code}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# C. chat エンドポイント probe — POST 認証なしで 401/400/405 を確認 (存在確認)
#    GET は 404 だが POST は 401 を返す正常動作
# ─────────────────────────────────────────────────────────────────────────────
echo "── C. chat エンドポイント probe"
chat_code=$(http_post_status "${API_URL}/api/chat")
case "${chat_code}" in
  200|401|400|405)
    pass "POST /api/chat → HTTP ${chat_code} (エンドポイント存在確認 OK)" ;;
  *)
    fail "POST /api/chat → HTTP ${chat_code} (unexpected)" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# D. widget endpoint — carnation-demo + widget.js 配信確認
# ─────────────────────────────────────────────────────────────────────────────
echo "── D. widget endpoint 確認"
demo_code=$(http_status "${API_URL}/carnation-demo/")
case "${demo_code}" in
  200|301|302)
    pass "/carnation-demo/ → ${demo_code}" ;;
  *)
    fail "/carnation-demo/ → HTTP ${demo_code} (expected 200/3xx)" ;;
esac

wjs_code=$(http_status "${API_URL}/widget.js")
if [[ "${wjs_code}" == "200" ]]; then
  pass "/widget.js → 200"
else
  fail "/widget.js → HTTP ${wjs_code} (expected 200)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# E. avatar-agent token probe — 認証なし 401/403 を確認 (auth guard 生存確認)
# ─────────────────────────────────────────────────────────────────────────────
echo "── E. avatar-agent endpoint probe"
avatar_code=$(http_status "${API_URL}/api/internal/avatar-config/token")
case "${avatar_code}" in
  401|403)
    pass "/api/internal/avatar-config/token → ${avatar_code} (auth guard OK)" ;;
  404)
    echo "  ⏭  /api/internal/avatar-config/token → 404 SKIP (ルート未実装)" ;;
  *)
    fail "/api/internal/avatar-config/token → HTTP ${avatar_code} (unexpected)" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# 結果サマリ
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────"
echo "Gate 8 結果: PASS=${PASS} / FAIL=${FAIL}"

if [[ ${FAIL} -gt 0 ]]; then
  echo ""
  echo "⛔ 失敗項目:"
  for msg in "${FAIL_MSGS[@]}"; do
    echo "  - ${msg}"
  done
  echo ""
  echo "❌ Gate 8 FAIL — 直近 PR の rollback を検討してください"
  exit 1
fi

echo "✅ Gate 8 PASS"
