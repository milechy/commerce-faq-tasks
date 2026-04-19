#!/usr/bin/env bash
set -euo pipefail

# Phase28: VPS deploy script
# Usage: bash SCRIPTS/deploy-vps.sh [user@host]
#
# NOTE: As of 2026-04-17, Admin UI is served via Cloudflare Pages.
# This script deploys API + Widget + avatar-agent only to VPS.
# Admin UI deployment is handled automatically by Cloudflare Pages
# when changes are pushed to the main branch.
#
# Prerequisites on VPS:
#   - Node.js 20.x installed
#   - corepack enable && corepack prepare pnpm@9.15.9 --activate
#   - npm install -g pm2
#   - PostgreSQL + Elasticsearch running

VPS="${1:-root@65.108.159.161}"
REMOTE_DIR="/opt/rajiuce"

# Pre-deploy: Environment Check (warning-only, does not block deploy)
echo "=== Pre-deploy: Environment Check ==="
bash SCRIPTS/env-check.sh 2>&1 || true
echo ""

echo "=== Phase28: Deploy to ${VPS}:${REMOTE_DIR} ==="

# === VPS Integrity Guards ===
echo "=== VPS Integrity Guards ==="

# Guard 4-B: Abort if VPS has uncommitted changes (VPS should be a clean deploy target)
UNCOMMITTED=$(ssh "${VPS}" "cd ${REMOTE_DIR} && git status --porcelain 2>/dev/null | wc -l | tr -d ' '" || echo "0")
if [ "${UNCOMMITTED}" -gt 0 ]; then
    echo "⚠️  WARNING: Uncommitted changes on VPS (${UNCOMMITTED} files):"
    ssh "${VPS}" "cd ${REMOTE_DIR} && git status --short" || true
    echo ""
    echo "🛑 Aborting deploy. VPS has local modifications that may be overwritten."
    echo "   To clean up VPS and retry:"
    echo "     ssh ${VPS} \"cd ${REMOTE_DIR} && git stash push -u -m 'backup-$(date +%Y%m%d)-before-reset' && git fetch origin && git reset --hard origin/main\""
    exit 1
fi
echo "  ✅ Guard 4-B: VPS git status clean"

# Guard 4-A: Detect recent npm usage (this project uses pnpm — npm install corrupts node_modules)
CLEAN_REBUILD=0
RECENT_NPM_LOG=$(ssh "${VPS}" "ls -t /root/.npm/_logs/*.log 2>/dev/null | head -1 || true" || echo "")
if [ -n "${RECENT_NPM_LOG}" ]; then
    LOG_AGE=$(ssh "${VPS}" "echo \$(( (\$(date +%s) - \$(stat -c %Y '${RECENT_NPM_LOG}' 2>/dev/null || echo 0)) / 86400 ))" || echo "99")
    if [ "${LOG_AGE}" -lt 7 ]; then
        echo "⚠️  Guard 4-A: Recent npm usage detected (${LOG_AGE}d ago: ${RECENT_NPM_LOG})"
        echo "⚠️  Direct npm install may have corrupted pnpm node_modules. Forcing clean rebuild."
        CLEAN_REBUILD=1
    fi
fi
[ "${CLEAN_REBUILD}" = "0" ] && echo "  ✅ Guard 4-A: No recent npm usage detected"

# Guard 4-C: Detect broken pnpm node_modules (pnpm uses symlinks; npm install creates real dirs)
# test -L returns true for symlinks (pnpm), false for real directories (npm-created)
for pkg in adm-zip express pdf-parse; do
    IS_SYMLINK=$(ssh "${VPS}" "test -L ${REMOTE_DIR}/node_modules/${pkg} && echo yes || echo no" || echo "no")
    if [ "${IS_SYMLINK}" = "no" ] && ssh "${VPS}" "test -e ${REMOTE_DIR}/node_modules/${pkg}" 2>/dev/null; then
        echo "⚠️  Guard 4-C: ${pkg} is a real directory, not a pnpm symlink. Forcing clean rebuild."
        CLEAN_REBUILD=1
    fi
done
[ "${CLEAN_REBUILD}" = "0" ] && echo "  ✅ Guard 4-C: pnpm symlinks intact"

if [ "${CLEAN_REBUILD}" = "1" ]; then
    echo "  🔧 Removing node_modules on VPS for clean rebuild..."
    ssh "${VPS}" "rm -rf ${REMOTE_DIR}/node_modules"
fi
echo ""

echo "[0/5] VPSファイル所有者正常化..."
# rsync -a がMac側のUID(501)を保持するため、pnpmがUID 1001 sandboxでvite buildを実行し
# 環境変数が継承されない問題を防ぐ。rsync前にVPS側をroot:rootに正規化する。
ssh "${VPS}" "chown -R root:root ${REMOTE_DIR} 2>/dev/null || true"
echo "  ✅ VPSファイル所有者: root:root に正規化完了"

echo "[1/5] Syncing repository to VPS..."
# NOTE: --exclude '.env*' prevents rsync --delete from wiping VPS env files.
# VPS holds the authoritative .env with production secrets.
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

# rsync後の所有者正規化: Mac側UID(501)がrsync -a で転送されてもroot:rootに上書き
ssh "${VPS}" "chown -R root:root ${REMOTE_DIR} 2>/dev/null || true"
echo "  ✅ rsync後VPSファイル所有者: root:root に正規化完了"

echo "[2/5] Installing dependencies on VPS..."
ssh "${VPS}" "cd ${REMOTE_DIR} && corepack enable && pnpm install --frozen-lockfile"

echo "[3/5] Building API server..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pnpm build"

echo "[4/5] Starting services with PM2..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pm2 startOrRestart ecosystem.config.cjs --env production --only rajiuce-api,rajiuce-avatar"
ssh "${VPS}" "pm2 save"

echo "[5/5] Reloading Nginx..."
ssh "${VPS}" "nginx -t && systemctl reload nginx && echo ' Nginx reloaded OK' || echo ' Nginx reload FAILED'"

echo "=== Health check ==="
sleep 3  # PM2 起動待ち
ssh "${VPS}" "curl -sf http://localhost:3100/health && echo ' API OK' || echo ' API FAILED'"

echo ""
echo "=== Running post-deploy smoke test ==="
bash SCRIPTS/post-deploy-smoke.sh || echo "⚠️  Some smoke tests failed (non-blocking)"

echo ""
echo "=== Deploy complete ==="
echo "API:      https://api.r2c.biz/health"
echo "Widget:   https://api.r2c.biz/widget.js"
echo "Admin UI: https://admin.r2c.biz/ (Cloudflare Pages — 自動デプロイ済み)"
echo ""
echo "NOTE: VPS .env is preserved by rsync (never overwritten)."
echo "  To update secrets: ssh root@65.108.159.161 'nano /opt/rajiuce/.env'"
echo ""
echo "First time? Run on VPS:"
echo "  pm2 startup"
echo "  pm2 install pm2-logrotate"
