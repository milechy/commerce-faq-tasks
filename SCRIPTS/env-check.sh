#!/bin/bash
# SCRIPTS/env-check.sh
# コード内で使用されているprocess.env.* と .env.example の整合性チェック
# 使用: bash SCRIPTS/env-check.sh
# 終了コード: 0 (warning-only — deploy-vps.shの冒頭で呼ばれる)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Environment Variable Check ($(date '+%Y-%m-%d %H:%M:%S')) ==="
echo ""

# ── 1. コードから使用されている環境変数を抽出 ─────────────────────────────
CODE_VARS=$(grep -roh "process\.env\.[A-Z_][A-Z0-9_]*" src/ --include="*.ts" 2>/dev/null \
  | sed "s/process\.env\.//" | sort -u)

CODE_COUNT=$(echo "$CODE_VARS" | grep -c "" || echo "0")
echo "Variables referenced in src/: $CODE_COUNT"

# ── 2. .env.example の確認 ────────────────────────────────────────────────
if [ -f .env.example ]; then
  EXAMPLE_VARS=$(grep -v '^#' .env.example | grep '=' | cut -d= -f1 | sort -u)
  EXAMPLE_COUNT=$(echo "$EXAMPLE_VARS" | grep -c "" || echo "0")
  echo "Variables defined in .env.example: $EXAMPLE_COUNT"
  echo ""

  # ── 3. コードにあるが .env.example にない変数 ───────────────────────────
  echo "--- In code but NOT in .env.example (may need adding) ---"
  MISSING_COUNT=0
  while IFS= read -r var; do
    if ! echo "$EXAMPLE_VARS" | grep -qx "$var"; then
      # 内部/テスト用変数をフィルタリング（NODE_ENV, PORT は通常不要）
      case "$var" in
        NODE_ENV|PORT) echo "  ℹ️  $var (standard — ok to skip)" ;;
        *)             echo "  ⚠️  $var"; MISSING_COUNT=$((MISSING_COUNT + 1)) ;;
      esac
    fi
  done <<< "$CODE_VARS"

  if [ "$MISSING_COUNT" -eq 0 ]; then
    echo "  ✅ All code variables are in .env.example"
  else
    echo "  → $MISSING_COUNT variable(s) missing from .env.example"
  fi
  echo ""

  # ── 4. .env.example にあるがコードにない変数 ────────────────────────────
  echo "--- In .env.example but NOT in code (possibly stale) ---"
  STALE_COUNT=0
  while IFS= read -r var; do
    if ! echo "$CODE_VARS" | grep -qx "$var"; then
      echo "  🗑️  $var"
      STALE_COUNT=$((STALE_COUNT + 1))
    fi
  done <<< "$EXAMPLE_VARS"

  if [ "$STALE_COUNT" -eq 0 ]; then
    echo "  ✅ No stale entries in .env.example"
  else
    echo "  → $STALE_COUNT potentially stale variable(s) in .env.example"
  fi

else
  # .env.example が存在しない場合は自動生成
  echo "⚠️  .env.example not found!"
  echo "Creating from code analysis..."

  {
    echo "# R2C / RAJIUCE — Environment Variables"
    echo "# Auto-generated from code analysis $(date '+%Y-%m-%d')"
    echo "# Review and fill in values before deploying"
    echo ""
    while IFS= read -r var; do
      echo "${var}="
    done <<< "$CODE_VARS"
  } > .env.example

  GEN_COUNT=$(echo "$CODE_VARS" | grep -c "")
  echo "✅ .env.example created with $GEN_COUNT variables"
fi

echo ""
echo "=== Env Check Complete ==="
# warning-only — デプロイをブロックしない
exit 0
