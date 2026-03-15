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
  ./ "${VPS}:${REMOTE_DIR}/"

echo "[2/6] Installing dependencies on VPS..."
ssh "${VPS}" "cd ${REMOTE_DIR} && corepack enable && pnpm install --frozen-lockfile"

echo "[3/6] Building API server..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pnpm build"

echo "[4/6] Building Admin UI..."
# Verify required env vars are present before building (prevents empty-string Supabase URL in bundle)
ssh "${VPS}" "
  set -e
  cd ${REMOTE_DIR}/admin-ui
  if [ -f .env.local ]; then
    source <(grep -v '^#' .env.local | xargs)
  elif [ -f .env ]; then
    source <(grep -v '^#' .env | xargs)
  fi
  if [ -z \"\${VITE_SUPABASE_URL:-}\" ] || [ -z \"\${VITE_SUPABASE_ANON_KEY:-}\" ]; then
    echo '❌ ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です'
    echo '   /opt/rajiuce/admin-ui/.env.local に設定してください'
    exit 1
  fi
  pnpm install --frozen-lockfile
  pnpm build
  echo '✅ Admin UI built with Supabase URL: '\$(grep -c 'supabase.co' dist/assets/*.js)' reference(s) in bundle'
"

echo "[5/6] Starting services with PM2..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pm2 startOrRestart ecosystem.config.cjs --env production"
ssh "${VPS}" "pm2 save"

echo "[6/6] Health check..."
sleep 3
ssh "${VPS}" "curl -sf http://localhost:3100/health && echo ' API OK' || echo ' API FAILED'"
ssh "${VPS}" "curl -sf http://localhost:5173/ | grep -q 'root' && echo ' Admin UI OK' || echo ' Admin UI FAILED'"

echo ""
echo "=== Deploy complete ==="
echo "API:      http://65.108.159.161:3100/health"
echo "Admin UI: http://65.108.159.161:5173/"
echo "Widget:   http://65.108.159.161:3100/widget.js"
echo ""
echo "NOTE: VPS env files are preserved by rsync (never overwritten)."
echo "  To update secrets: ssh root@65.108.159.161 'nano /opt/rajiuce/admin-ui/.env.local'"
echo "  Then re-run this script to rebuild with updated values."
echo ""
echo "First time? Run on VPS:"
echo "  pm2 startup"
echo "  pm2 install pm2-logrotate"
echo "  # Create /opt/rajiuce/admin-ui/.env.local with VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_BASE"
