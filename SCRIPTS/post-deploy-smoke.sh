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

# ── 3b. Admin UI アセットのCDNキャッシュ破損検知 ───────────────────────
# PR #487の事故: index.htmlは正しいJSファイル名を参照していたが、CDNの
# 一部エッジがそのURLに対してHTML(SPAフォールバック)の中身を誤って
# キャッシュしていた。Content-Typeヘッダは正しくJSを返しつつボディだけ
# HTMLだったため、ヘッダだけでは検知できない。実ボディの先頭文字を見る。
admin_html=$(curl -s --max-time 10 "$ADMIN_URL" 2>/dev/null || echo "")
admin_js_path=$(echo "$admin_html" | grep -oE '/assets/[A-Za-z0-9_.-]+\.js' | head -1)
if [ -n "$admin_js_path" ]; then
  # `curl | head -c 1` は head がパイプを閉じた後も curl が本体(数百KB〜)を
  # 送り続けようとして SIGPIPE を受け、set -e + pipefail 下ではその場で
  # スクリプト全体が無言で落ちる(以降の全チェックが未実行になる)。
  # HTTP Range で1バイトだけをサーバに要求すれば、ローカルのパイプ切断も
  # 大きな本体のダウンロードも発生しない。
  admin_js_body_head=$(curl -s --max-time 10 -r 0-0 "$ADMIN_URL$admin_js_path" 2>/dev/null || echo "")
  if [ "$admin_js_body_head" = "<" ]; then
    echo "  ❌ Admin UI asset ($admin_js_path) body starts with '<' — CDNキャッシュ破損の疑い(HTMLが返っている)"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ Admin UI asset ($admin_js_path) — JS本文を確認"
    PASS=$((PASS + 1))
  fi
else
  echo "  ⚠️  Admin UI index.html から /assets/*.js を検出できず(スキップ)"
fi

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

# ── 5c. nginx 経由の loopback は 200 を返す ──────────────────────────────
# Codex MEDIUM 反映: nginx の proxy_set_header 設定誤りで loopback 経由も
# 200 を返せなくなる lockout を検出する。Pre-A 時点と Post-A 時点で意味が
# 変わる(Post: nginx が "1" を注入してくれるのでヘッダなしでも 200)。
# GID 1216274383891431: `location = /metrics` は listen 443 ssl ブロックにのみ
# 定義されており、port 80 には対応する location が存在しない(:80 は
# api.r2c.biz への301リダイレクトのみ)。素の http://127.0.0.1/metrics は
# Hostヘッダがapi.r2c.bizと一致せず304リダイレクトにも入らないため常に404に
# なる恒常的なバグだった。--resolve で正しいHost/SNIをloopbackに向けて
# https でアクセスする。
nginx_loopback_status=$(ssh "${VPS}" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  --resolve api.r2c.biz:443:127.0.0.1 https://api.r2c.biz/metrics 2>/dev/null" 2>/dev/null || echo "000")
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

# ── 7. テナント認証経路の実チェック (GID 1218171750803663) ──────────────────
# 2026-09-04、seedTenantsFromDBが一過性で一部テナントを欠落させ、該当テナントの
# /api/chat・アバター系が全滅した事象が発生した。サーバ自体は/health等で200を
# 返し続けており、既存のHTTPレベルのチェックはこの障害をすり抜ける
# (「サーバは200を返すがテナント固有の認証だけ壊れている」パターン)。
# 実在テナントのAPIキーで /api/chat を実際に叩き、テナント認証経路が生きている
# ことを確認する。キーはリポジトリに置かず、VPS上の.envから該当行のみを
# grepで抽出する(.envをsourceしない — プレースホルダ行での構文崩壊による
# 秘密鍵のecho漏洩を過去に起こしているため、必要変数のみを個別に取り出す)。
smoke_tenant_key=$(ssh "${VPS}" "grep -m1 '^SMOKE_TEST_TENANT_API_KEY=' /opt/rajiuce/.env 2>/dev/null | cut -d= -f2-" 2>/dev/null || echo "")

if [ -n "$smoke_tenant_key" ]; then
  tenant_chat_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -X POST "$API_URL/api/chat" \
    -H "x-api-key: ${smoke_tenant_key}" \
    -H "Content-Type: application/json" \
    -d '{"message":"smoke-test"}' 2>/dev/null || echo "000")
  if [ "$tenant_chat_status" = "200" ]; then
    echo "  ✅ /api/chat テナント認証 — $tenant_chat_status"
    PASS=$((PASS + 1))
  else
    echo "  ❌ /api/chat テナント認証 — got $tenant_chat_status (expected 200; seedTenantsFromDBのテナント欠落 or 認証経路の破損の疑い。ssh ${VPS} 'pm2 restart rajiuce-api' で復旧するか確認)"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ⚠️  SMOKE_TEST_TENANT_API_KEY 未設定 — テナント認証チェックをスキップ"
  echo "     (VPSの/opt/rajiuce/.envに、専用の低権限テナントのAPIキーを SMOKE_TEST_TENANT_API_KEY として設定してください)"
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
