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
rsync -avz --delete \
  --exclude node_modules \
  --exclude .pnpm-store \
  --exclude dist \
  --exclude admin-ui/node_modules \
  --exclude admin-ui/dist \
  --exclude .git \
  --exclude logs \
  --exclude '*.log' \
  ./ "${VPS}:${REMOTE_DIR}/"

echo "[2/6] Installing dependencies on VPS..."
ssh "${VPS}" "cd ${REMOTE_DIR} && corepack enable && pnpm install --frozen-lockfile"

echo "[3/6] Building API server..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pnpm build"

echo "[4/6] Building Admin UI..."
ssh "${VPS}" "cd ${REMOTE_DIR}/admin-ui && pnpm install --frozen-lockfile && pnpm build"

echo "[5/6] Starting services with PM2..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pm2 startOrRestart ecosystem.config.cjs --env production"
ssh "${VPS}" "pm2 save"

echo "[6/6] Health check..."
sleep 3
ssh "${VPS}" "curl -sf http://localhost:3100/health && echo ' OK' || echo ' FAILED'"

echo ""
echo "=== Deploy complete ==="
echo "API:      http://65.108.159.161:3100/health"
echo "Admin UI: http://65.108.159.161:5173/"
echo "Widget:   http://65.108.159.161:3100/widget.js"
echo ""
echo "First time? Run on VPS:"
echo "  pm2 startup"
echo "  pm2 install pm2-logrotate"
