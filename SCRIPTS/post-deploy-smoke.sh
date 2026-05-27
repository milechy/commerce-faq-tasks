#!/bin/bash
# SCRIPTS/post-deploy-smoke.sh
# デプロイ後に主要エンドポイントを自動チェック
# 使用: bash SCRIPTS/post-deploy-smoke.sh [API_URL] [ADMIN_URL]
# 終了コード: 0=全成功, 1=1件以上失敗

set -euo pipefail

API_URL="${1:-https://api.r2c.biz}"
ADMIN_URL="${2:-https://admin.r2c.biz}"
VPS="${3:-root@65.108.159.161}"
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

# ── 5. Metrics（VPS内 localhost 経由でのみ確認）─────────────────────────
# 注: /metrics は外部からは nginx allow 127.0.0.1; deny all; で必ず 403。
# 内部疎通は ssh で VPS に入ってから http://localhost:3100 を叩いて確認する。
metrics_status=$(ssh "${VPS}" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -H 'X-Internal-Request: 1' http://localhost:3100/metrics 2>/dev/null" 2>/dev/null || echo "000")
if [ "$metrics_status" = "200" ]; then
  echo "  ✅ Metrics — $metrics_status (localhost on VPS)"
  PASS=$((PASS + 1))
else
  # Codex Round 2: 内部メトリクスは observability の生命線。WARN ではなく
  # FAIL にして deploy ゲートで止める（observability regression を看過させない）。
  echo "  ❌ Metrics — $metrics_status (expected 200 via VPS localhost:3100)"
  FAIL=$((FAIL + 1))
fi

# ── 5b. 公開面では /metrics は必ず deny される（spoof閉塞の確認）──────
public_metrics_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "X-Internal-Request: 1" "$API_URL/metrics" 2>/dev/null || echo "000")
if [ "$public_metrics_status" = "403" ] || [ "$public_metrics_status" = "404" ]; then
  echo "  ✅ /metrics public spoof denied — $public_metrics_status"
  PASS=$((PASS + 1))
else
  echo "  ❌ /metrics is reachable from public with header — got $public_metrics_status (expected 403/404)"
  FAIL=$((FAIL + 1))
fi

# ── 5c. nginx 経由の loopback (VPSローカルhttp 127.0.0.1) は 200 を返す ──
# Codex MEDIUM 反映: nginx の proxy_set_header 設定誤りで loopback 経由も
# 200 を返せなくなる lockout を検出する。Pre-A 時点と Post-A 時点で意味が
# 変わる(Post: nginx が "1" を注入してくれるのでヘッダなしでも 200)。
nginx_loopback_status=$(ssh "${VPS}" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  http://127.0.0.1/metrics 2>/dev/null" 2>/dev/null || echo "000")
if [ "$nginx_loopback_status" = "200" ]; then
  echo "  ✅ /metrics via nginx loopback — $nginx_loopback_status"
  PASS=$((PASS + 1))
else
  # Codex Round 2: nginx ↔ Express の interplay が壊れたら 200 を返せなくなる。
  # 検出を deploy ゲートで強制するため FAIL に格上げ。
  echo "  ❌ /metrics via nginx loopback — $nginx_loopback_status (expected 200, check nginx X-Internal-Request injection / IP allow)"
  FAIL=$((FAIL + 1))
fi

# ── 6. avatar-agent PM2 status ────────────────────────────────────────────
avatar_status=$(ssh "${VPS}" "pm2 describe rajiuce-avatar 2>/dev/null | grep -E 'status.*online' | wc -l | tr -d ' '" 2>/dev/null || echo "0")
if [ "$avatar_status" -gt 0 ]; then
  echo "  ✅ rajiuce-avatar — online"
  PASS=$((PASS + 1))
else
  echo "  ❌ rajiuce-avatar — not online (check: ssh ${VPS} 'pm2 logs rajiuce-avatar --lines 50 --nostream')"
  FAIL=$((FAIL + 1))
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
