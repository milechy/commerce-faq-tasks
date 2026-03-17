#!/usr/bin/env bash
# SCRIPTS/build-admin-ui.sh
# VPS上で直接実行するAdmin UIビルドスクリプト。
# SSH heredocのエスケープ問題を完全に排除するため独立スクリプトとして分離。
set -euo pipefail

cd /opt/rajiuce/admin-ui

# ── env ファイル検出 ──────────────────────────────────────────
ENV_FILE=""
if [ -f .env.local ]; then
  ENV_FILE=".env.local"
elif [ -f .env ]; then
  ENV_FILE=".env"
fi

if [ -z "${ENV_FILE}" ]; then
  echo "❌ ERROR: admin-ui/.env.local が見つかりません"
  echo "   /opt/rajiuce/admin-ui/.env.local を作成してください"
  echo "   必須キー: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_BASE"
  exit 1
fi

# ── VITE_変数を個別にexport ────────────────────────────────────
while IFS= read -r line || [ -n "$line" ]; do
  # コメント行・空行をスキップ
  [[ "$line" =~ ^#.*$ ]] && continue
  [[ -z "$line" ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY|VITE_API_BASE)
      export "$key"="$value"
      echo "  $key=${value:0:30}..."
      ;;
  esac
done < "$ENV_FILE"

# ── 必須チェック ──────────────────────────────────────────────
if [ -z "${VITE_SUPABASE_URL:-}" ]; then
  echo "❌ FATAL: VITE_SUPABASE_URL is empty after export"
  exit 1
fi

echo "✅ env check passed (${ENV_FILE}): ${VITE_SUPABASE_URL}"

# ── キャッシュクリア + ビルド ─────────────────────────────────
rm -rf dist node_modules/.vite
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build

# ── ビルド後検証 ──────────────────────────────────────────────
if ! grep -ql "${VITE_SUPABASE_URL}" dist/assets/*.js 2>/dev/null; then
  echo "❌ FATAL: Supabase URL not found in bundle after build"
  echo "Expected: ${VITE_SUPABASE_URL}"
  exit 1
fi

echo "✅ Admin UI built with Supabase URL verified in bundle"
