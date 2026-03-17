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
  ./ "${VPS}:${REMOTE_DIR}/"

echo "[2/6] Installing dependencies on VPS..."
ssh "${VPS}" "cd ${REMOTE_DIR} && corepack enable && pnpm install --frozen-lockfile"

echo "[3/6] Building API server..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pnpm build"

echo "[4/6] Building Admin UI..."
ssh "${VPS}" "
  set -e
  cd ${REMOTE_DIR}/admin-ui

  # ── env ファイル検出 ──────────────────────────────────────────
  ENV_FILE=''
  if [ -f .env.local ]; then
    ENV_FILE='.env.local'
  elif [ -f .env ]; then
    ENV_FILE='.env'
  fi
  if [ -z \"\${ENV_FILE}\" ]; then
    echo '❌ ERROR: admin-ui/.env.local が見つかりません'
    echo '   /opt/rajiuce/admin-ui/.env.local を作成してください'
    echo '   必須キー: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_BASE'
    exit 1
  fi

  # ── キーの存在確認 ─────────────────────────────────────────────
  if ! grep -q 'VITE_SUPABASE_URL=.' \"\${ENV_FILE}\"; then
    echo \"❌ ERROR: \${ENV_FILE} に VITE_SUPABASE_URL が設定されていません\"
    exit 1
  fi
  if ! grep -q 'VITE_SUPABASE_ANON_KEY=.' \"\${ENV_FILE}\"; then
    echo \"❌ ERROR: \${ENV_FILE} に VITE_SUPABASE_ANON_KEY が設定されていません\"
    exit 1
  fi

  # 実際のURLを取得（ビルド後の検証に使う）
  SUPABASE_URL=\$(grep 'VITE_SUPABASE_URL=' \"\${ENV_FILE}\" | head -1 | cut -d'=' -f2- | tr -d '\"' | tr -d \"'\")
  echo \"✅ env check passed (\${ENV_FILE}): \${SUPABASE_URL}\"

  # ── stale Viteキャッシュをクリア（env変数の埋め込み漏れを防止）──
  rm -rf dist node_modules/.vite

  pnpm install --frozen-lockfile
  pnpm build

  # ── ビルド後検証: 実際のSupabase URLがバンドルに埋め込まれたか確認 ──
  # 注: grep -c はファイルが複数あると「file:count」形式になり '0' 比較が壊れる。
  #     grep -ql を使い終了コードで判定する（正しい方法）。
  if ! grep -ql \"\${SUPABASE_URL}\" dist/assets/*.js 2>/dev/null; then
    echo '❌ ERROR: Supabase URLがバンドルに含まれていません。再ビルドを試みます...'
    rm -rf dist node_modules/.vite
    # フォールバック: env変数を明示的にシェルにエクスポートして再ビルド
    set -a
    . \"./\${ENV_FILE}\"
    set +a
    pnpm build
    if ! grep -ql \"\${SUPABASE_URL}\" dist/assets/*.js 2>/dev/null; then
      echo '❌ FATAL: 再ビルドも失敗しました。.env.localの内容を確認してください:'
      cat \"\${ENV_FILE}\"
      exit 1
    fi
    echo '✅ Admin UI rebuilt successfully (fallback build used)'
  fi
  echo '✅ Admin UI built with Supabase URL verified in bundle'
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
