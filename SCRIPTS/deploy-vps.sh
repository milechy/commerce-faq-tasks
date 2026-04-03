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

echo "=== Phase28: Deploy to ${VPS}:${REMOTE_DIR} ==="

echo "[1/6] Syncing repository to VPS..."
# NOTE: --exclude '.env*' prevents rsync --delete from wiping VPS env files.
# VPS holds the authoritative .env / .env.local with production secrets.
rsync -avz --delete \
  --exclude node_modules \
  --exclude .pnpm-store \
  --exclude dist \
  --exclude admin-ui/node_modules \
  --exclude admin-ui/dist \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.git' \
  --exclude logs \
  --exclude '*.log' \
  --exclude '*.zip' \
  --exclude '_bundle' \
  --exclude '.DS_Store' \
  --exclude '.vscode' \
  --exclude '.devcontainer' \
  --exclude '__pycache__' \
  --exclude 'avatar-agent/venv' \
  ./ "${VPS}:${REMOTE_DIR}/"

echo "[2/6] Installing dependencies on VPS..."
ssh "${VPS}" "cd ${REMOTE_DIR} && corepack enable && pnpm install --frozen-lockfile"

echo "[3/6] Building API server..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pnpm build"

echo "[4/6] Building Admin UI..."
echo "  Clearing Vite cache before build..."
ssh "${VPS}" "cd ${REMOTE_DIR}/admin-ui && rm -rf dist node_modules/.vite node_modules/.cache .vite"
ssh "${VPS}" "bash ${REMOTE_DIR}/SCRIPTS/build-admin-ui.sh"

# ── ビルド後の最終検証: Supabase URLがバンドルに含まれているか ──
echo "  Verifying admin-ui bundle..."
BUNDLE_OK=$(ssh "${VPS}" "grep -c 'rpqrwi' ${REMOTE_DIR}/admin-ui/dist/assets/index-*.js 2>/dev/null || echo 0")
if [ "${BUNDLE_OK}" = "0" ]; then
  echo "  ⚠️  First build missing Supabase URL. Rebuilding..."
  ssh "${VPS}" "cd ${REMOTE_DIR}/admin-ui && rm -rf dist node_modules/.vite node_modules/.cache .vite && bash ${REMOTE_DIR}/SCRIPTS/build-admin-ui.sh"
  BUNDLE_OK2=$(ssh "${VPS}" "grep -c 'rpqrwi' ${REMOTE_DIR}/admin-ui/dist/assets/index-*.js 2>/dev/null || echo 0")
  if [ "${BUNDLE_OK2}" = "0" ]; then
    echo "  ❌ FATAL: Admin UI build failed twice. Aborting deploy."
    exit 1
  fi
  echo "  ✅ Rebuild successful"
fi
echo "  ✅ Admin UI bundle verified (Supabase URL present)"

echo "  Reloading Nginx to serve new Admin UI build..."
ssh "${VPS}" "nginx -s reload && echo '  ✅ Nginx reloaded' || echo '  ⚠️  Nginx reload failed (non-fatal)'"

echo "[5/6] Starting services with PM2..."
# rajiuce-admin は Nginx が直接配信するため除外。slack-listener はスクリプト不在のため除外。
ssh "${VPS}" "cd ${REMOTE_DIR} && pm2 startOrRestart ecosystem.config.cjs --env production --only rajiuce-api,rajiuce-avatar"
ssh "${VPS}" "pm2 save"

echo "[6/6] Reloading Nginx..."
ssh "${VPS}" "nginx -t && systemctl reload nginx && echo ' Nginx reloaded OK' || echo ' Nginx reload FAILED'"

echo "[7/7] Health check..."
sleep 3
ssh "${VPS}" "curl -sf http://localhost:3100/health && echo ' API OK' || echo ' API FAILED'"
ssh "${VPS}" "curl -sf http://localhost:5173/ | grep -q 'root' && echo ' Admin UI OK' || echo ' Admin UI FAILED'"

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
