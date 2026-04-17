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

# ── VITE_変数を個別にexport (shell スコープ用) ────────────────
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
if [ -z "${VITE_SUPABASE_ANON_KEY:-}" ]; then
  echo "❌ FATAL: VITE_SUPABASE_ANON_KEY is empty after export"
  exit 1
fi
if [ -z "${VITE_API_BASE:-}" ]; then
  echo "❌ FATAL: VITE_API_BASE is empty after export"
  exit 1
fi

echo "✅ env check passed (${ENV_FILE}): ${VITE_SUPABASE_URL}"

# ── キャッシュクリア + インストール ───────────────────────────
# node_modules/.vite と node_modules/.cache も除去して
# 前回の不正ビルドキャッシュが再利用されないようにする
rm -rf dist node_modules/.vite node_modules/.cache .vite
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# ── インライン環境変数注入でビルド ────────────────────────────
# pnpm build はサブシェルで実行されるため export の継承が不安定。
# インライン注入（KEY=val pnpm build）で確実に Vite へ渡す。
VITE_SUPABASE_URL="${VITE_SUPABASE_URL}" \
VITE_SUPABASE_ANON_KEY="${VITE_SUPABASE_ANON_KEY}" \
VITE_API_BASE="${VITE_API_BASE}" \
pnpm build

# ── ビルド後検証 ──────────────────────────────────────────────

# Supabase プロジェクトIDを動的抽出（ハードコード排除）
SUPABASE_PROJECT_ID=$(echo "$VITE_SUPABASE_URL" | sed -E 's|https://([^.]+)\..*|\1|')
if [ -z "$SUPABASE_PROJECT_ID" ]; then
  echo "❌ FATAL: VITE_SUPABASE_URL からプロジェクトIDを抽出できませんでした"
  exit 1
fi

# フォールバック値が埋め込まれていないか検証
if grep -q "not-configured.invalid" dist/assets/*.js 2>/dev/null; then
  echo "❌ FATAL: bundleに 'not-configured.invalid' フォールバック値が検出されました"
  echo "   Viteが環境変数を受け取れていません"
  echo "   debug: VITE_SUPABASE_URL=${VITE_SUPABASE_URL:0:30}..."
  exit 1
fi

# Supabase プロジェクトIDが焼き込まれていることを検証
if ! grep -q "${SUPABASE_PROJECT_ID}" dist/assets/*.js 2>/dev/null; then
  echo "❌ FATAL: bundleに Supabase プロジェクトID (${SUPABASE_PROJECT_ID}) が焼き込まれていません"
  exit 1
fi

echo "✅ Build verification passed:"
echo "   - Supabase project ID: ${SUPABASE_PROJECT_ID}"
echo "   - no 'not-configured' fallback detected"
echo "✅ Admin UI built successfully"
