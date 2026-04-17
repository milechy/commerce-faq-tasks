#!/usr/bin/env bash
set -euo pipefail

# Phase28: VPS deploy script
# Usage: bash SCRIPTS/deploy-vps.sh [user@host]
#
# Prerequisites on VPS:
#   - Node.js 20.x installed
#   - corepack enable && corepack prepare pnpm@9.15.9 --activate
#   - npm install -g pm2 serve
#   - PostgreSQL + Elasticsearch running

VPS="${1:-root@65.108.159.161}"
REMOTE_DIR="/opt/rajiuce"

# Pre-deploy: Environment Check (warning-only, does not block deploy)
echo "=== Pre-deploy: Environment Check ==="
bash SCRIPTS/env-check.sh 2>&1 || true
echo ""

echo "=== Phase28: Deploy to ${VPS}:${REMOTE_DIR} ==="

echo "[1/6] Syncing repository to VPS..."
# NOTE: --exclude '.env*' prevents rsync --delete from wiping VPS env files.
# VPS holds the authoritative .env / .env.local with production secrets.
# NOTE: 'admin-ui/dist/' は除外必須 — ローカルビルド成果物にはVITE_変数が入らない。
#   VPS上では build-admin-ui.sh が .env.local を読んで正しくビルドする。
rsync -avz --delete \
  --exclude 'node_modules/' \
  --exclude '.pnpm-store/' \
  --exclude 'dist/' \
  --exclude 'admin-ui/node_modules/' \
  --exclude 'admin-ui/dist/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.git/' \
  --exclude 'logs/' \
  --exclude '*.log' \
  --exclude '*.zip' \
  --exclude '_bundle/' \
  --exclude '.DS_Store' \
  --exclude '.vscode/' \
  --exclude '.devcontainer/' \
  --exclude '__pycache__/' \
  --exclude 'avatar-agent/venv/' \
  ./ "${VPS}:${REMOTE_DIR}/"

echo "[2/6] Installing dependencies on VPS..."
ssh "${VPS}" "cd ${REMOTE_DIR} && corepack enable && pnpm install --frozen-lockfile"

echo "[3/6] Building API server..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pnpm build"

# === Admin UI .env.local 検証（根絶ガード） ===
echo "=== Checking admin-ui/.env.local on VPS ==="
ENV_CHECK=$(ssh "$VPS" "
  FILE='/opt/rajiuce/admin-ui/.env.local'
  if [ ! -f \"\$FILE\" ]; then
    echo 'MISSING'
    exit 1
  fi
  MISSING=''
  grep -q 'VITE_API_BASE=' \"\$FILE\" || MISSING=\"\${MISSING} VITE_API_BASE\"
  grep -q 'VITE_SUPABASE_URL=' \"\$FILE\" || MISSING=\"\${MISSING} VITE_SUPABASE_URL\"
  grep -q 'VITE_SUPABASE_ANON_KEY=' \"\$FILE\" || MISSING=\"\${MISSING} VITE_SUPABASE_ANON_KEY\"
  if [ -n \"\$MISSING\" ]; then
    echo \"MISSING_KEYS:\$MISSING\"
    exit 1
  fi
  echo 'OK'
")

if [ "$ENV_CHECK" != "OK" ]; then
  echo "❌ admin-ui/.env.local check FAILED: $ENV_CHECK"
  echo ""
  echo "VPS上で以下を実行して .env.local を復旧してください:"
  echo "  ssh root@65.108.159.161 \"cat > /opt/rajiuce/admin-ui/.env.local << 'EOF'"
  echo "VITE_API_BASE=https://api.r2c.biz"
  echo "VITE_SUPABASE_URL=https://rpqrwifbrhlebbelyqog.supabase.co"
  echo "VITE_SUPABASE_ANON_KEY=<Supabaseダッシュボードから取得>"
  echo "EOF\""
  exit 1
fi
echo "✅ admin-ui/.env.local: 3キー確認OK"

echo "[4/6] Building Admin UI..."
echo "  Clearing Vite cache before build..."
ssh "${VPS}" "cd ${REMOTE_DIR}/admin-ui && rm -rf dist node_modules/.vite node_modules/.cache .vite"
ssh "${VPS}" "bash ${REMOTE_DIR}/SCRIPTS/build-admin-ui.sh"

# ── ビルド後の最終検証: Supabase URLがバンドルに含まれているか ──
# プロジェクトIDを .env.local から動的取得（ハードコード排除）
echo "  Verifying admin-ui bundle..."
SUPABASE_PROJECT_ID=$(ssh "${VPS}" "
  ENV_FILE=''
  [ -f ${REMOTE_DIR}/admin-ui/.env.local ] && ENV_FILE='${REMOTE_DIR}/admin-ui/.env.local'
  [ -z \"\$ENV_FILE\" ] && [ -f ${REMOTE_DIR}/admin-ui/.env ] && ENV_FILE='${REMOTE_DIR}/admin-ui/.env'
  if [ -z \"\$ENV_FILE\" ]; then echo ''; exit 0; fi
  URL=\$(grep '^VITE_SUPABASE_URL=' \"\$ENV_FILE\" | head -1 | cut -d= -f2-)
  echo \"\$URL\" | sed -E 's|https://([^.]+)\\..*|\\1|'
" 2>/dev/null)

if [ -z "${SUPABASE_PROJECT_ID}" ]; then
  echo "  ❌ FATAL: VPS上の .env.local から Supabase プロジェクトIDを取得できませんでした"
  exit 1
fi

BUNDLE_OK=$(ssh "${VPS}" "grep -c '${SUPABASE_PROJECT_ID}' ${REMOTE_DIR}/admin-ui/dist/assets/index-*.js 2>/dev/null || echo 0")
BUNDLE_FALLBACK=$(ssh "${VPS}" "grep -c 'not-configured.invalid' ${REMOTE_DIR}/admin-ui/dist/assets/index-*.js 2>/dev/null || echo 0")

if [ "${BUNDLE_OK}" = "0" ] || [ "${BUNDLE_FALLBACK}" != "0" ]; then
  echo "  ERROR: bundle検証失敗 (project_id_found=${BUNDLE_OK}, fallback_found=${BUNDLE_FALLBACK}). Retrying build..."
  ssh "${VPS}" "cd ${REMOTE_DIR}/admin-ui && rm -rf dist node_modules/.vite node_modules/.cache .vite && bash ${REMOTE_DIR}/SCRIPTS/build-admin-ui.sh"
  BUNDLE_OK2=$(ssh "${VPS}" "grep -c '${SUPABASE_PROJECT_ID}' ${REMOTE_DIR}/admin-ui/dist/assets/index-*.js 2>/dev/null || echo 0")
  BUNDLE_FALLBACK2=$(ssh "${VPS}" "grep -c 'not-configured.invalid' ${REMOTE_DIR}/admin-ui/dist/assets/index-*.js 2>/dev/null || echo 0")
  if [ "${BUNDLE_OK2}" = "0" ] || [ "${BUNDLE_FALLBACK2}" != "0" ]; then
    echo "  ❌ FATAL: Admin UI build failed — bundle検証失敗 (project_id=${BUNDLE_OK2}, fallback=${BUNDLE_FALLBACK2})"
    exit 1
  fi
  echo "  ✅ Rebuild successful"
fi
echo "  ✅ Admin UI bundle verified (Supabase project ID: ${SUPABASE_PROJECT_ID})"

echo "  Reloading Nginx to serve new Admin UI build..."
ssh "${VPS}" "nginx -s reload && echo '  ✅ Nginx reloaded' || echo '  ⚠️  Nginx reload failed (non-fatal)'"

echo "[5/6] Starting services with PM2..."
# rajiuce-admin は Nginx が直接配信するため除外。slack-listener はスクリプト不在のため除外。
ssh "${VPS}" "cd ${REMOTE_DIR} && pm2 startOrRestart ecosystem.config.cjs --env production --only rajiuce-api,rajiuce-avatar,rajiuce-admin"
ssh "${VPS}" "pm2 save"

echo "[6/6] Reloading Nginx..."
ssh "${VPS}" "nginx -t && systemctl reload nginx && echo ' Nginx reloaded OK' || echo ' Nginx reload FAILED'"

echo "=== デプロイ後スモークテスト ==="
sleep 3  # nginx reload + PM2 起動待ち

# 本番サイトから配信中の bundle ファイル名を取得
DEPLOYED_BUNDLE=$(curl -sf "https://admin.r2c.biz/" | grep -oE "assets/index-[^\"]+\.js" | head -1 || true)
if [ -z "${DEPLOYED_BUNDLE}" ]; then
  echo "⚠️  WARNING: 本番サイトから bundle 名を取得できませんでした（スモークテストスキップ）"
else
  BUNDLE_CONTENT=$(curl -sf "https://admin.r2c.biz/${DEPLOYED_BUNDLE}" || true)
  if echo "${BUNDLE_CONTENT}" | grep -q "not-configured.invalid"; then
    echo "❌ FATAL: 本番 bundle にフォールバック値 'not-configured.invalid' が検出されました"
    echo "   Bundle: ${DEPLOYED_BUNDLE}"
    echo "   管理画面が 'Supabase未設定' エラーを表示します"
    exit 1
  fi
  if [ -n "${SUPABASE_PROJECT_ID}" ] && ! echo "${BUNDLE_CONTENT}" | grep -q "${SUPABASE_PROJECT_ID}"; then
    echo "❌ FATAL: 本番 bundle に Supabase プロジェクトID (${SUPABASE_PROJECT_ID}) が含まれていません"
    exit 1
  fi
  echo "✅ Smoke test passed: ${DEPLOYED_BUNDLE}"
fi

echo "[7/7] Health check..."
sleep 3
ssh "${VPS}" "curl -sf http://localhost:3100/health && echo ' API OK' || echo ' API FAILED'"
ssh "${VPS}" "curl -sf http://localhost:5173/ | grep -q 'root' && echo ' Admin UI OK' || echo ' Admin UI FAILED'"

echo ""
echo "=== Running post-deploy smoke test ==="
bash SCRIPTS/post-deploy-smoke.sh || echo "⚠️  Some smoke tests failed (non-blocking)"

echo ""
echo "=== Deploy complete ==="
echo "API:      https://api.r2c.biz/health"
echo "Admin UI: https://admin.r2c.biz/"
echo "Widget:   https://api.r2c.biz/widget.js"
echo ""
echo "NOTE: VPS env files are preserved by rsync (never overwritten)."
echo "  To update secrets: ssh root@65.108.159.161 'nano /opt/rajiuce/admin-ui/.env.local'"
echo "  Then re-run this script to rebuild with updated values."
echo ""
echo "First time? Run on VPS:"
echo "  pm2 startup"
echo "  pm2 install pm2-logrotate"
echo "  # Create /opt/rajiuce/admin-ui/.env.local with VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_BASE"
