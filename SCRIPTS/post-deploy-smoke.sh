#!/bin/bash
# SCRIPTS/post-deploy-smoke.sh
# デプロイ後に主要エンドポイントを自動チェック
# 使用: bash SCRIPTS/post-deploy-smoke.sh [API_URL] [ADMIN_URL]
# 終了コード: 0=全成功, 1=1件以上失敗

set -euo pipefail

API_URL="${1:-https://api.r2c.biz}"
ADMIN_URL="${2:-https://admin.r2c.biz}"
PASS=0
FAIL=0

check() {
  local name="$1"
  local url="$2"
  local expect_status="${3:-200}"

  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")

  if [ "$status" = "$expect_status" ]; then
    echo "  ✅ $name — $status"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name — got $status (expected $expect_status)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Post-Deploy Smoke Test ($(date '+%Y-%m-%d %H:%M:%S')) ==="
echo "  API:   $API_URL"
echo "  Admin: $ADMIN_URL"
echo ""

# ── 1. API Health ─────────────────────────────────────────────────────────
check "API /health" "$API_URL/health"

# health レスポンスのbodyも確認
health_body=$(curl -s --max-time 10 "$API_URL/health" 2>/dev/null || echo "{}")
health_status=$(echo "$health_body" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "?")
if [ "$health_status" = "ok" ]; then
  echo "  ✅ Health body.status = ok"
  PASS=$((PASS + 1))
else
  echo "  ⚠️  Health body.status = $health_status (expected 'ok')"
fi

# ── 2. Widget JS ──────────────────────────────────────────────────────────
check "Widget JS" "$API_URL/widget.js"

# Content-Type 確認
widget_ct=$(curl -sI --max-time 10 "$API_URL/widget.js" 2>/dev/null | grep -i "content-type" | tr -d '\r' | head -1)
if echo "$widget_ct" | grep -qi "javascript"; then
  echo "  ✅ Widget JS content-type: javascript"
  PASS=$((PASS + 1))
else
  echo "  ⚠️  Widget JS content-type unexpected: $widget_ct"
fi

# ── 3. Admin UI (Cloudflare Pages) ────────────────────────────────────────
check "Admin UI" "$ADMIN_URL"

# ── 4. Demo page ──────────────────────────────────────────────────────────
check "Demo page" "$API_URL/carnation-demo/index.html"

# ── 5. Metrics（内部リクエストヘッダー必要）─────────────────────────────
metrics_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "X-Internal-Request: 1" "$API_URL/metrics" 2>/dev/null || echo "000")
if [ "$metrics_status" = "200" ]; then
  echo "  ✅ Metrics — $metrics_status"
  PASS=$((PASS + 1))
else
  echo "  ⚠️  Metrics — $metrics_status (non-critical, requires X-Internal-Request header)"
fi

# ── 結果 ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  echo "⚠️  $FAIL check(s) failed! Review above."
  exit 1
fi

echo "✅ All critical smoke tests passed!"
exit 0
