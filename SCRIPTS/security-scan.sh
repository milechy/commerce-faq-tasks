#!/bin/bash
# RAJIUCE Security Scan Script
# Usage: bash SCRIPTS/security-scan.sh [--save]

SAVE=false
if [[ "$1" == "--save" ]]; then
  SAVE=true
  SAVE_DIR="logs/security"
  mkdir -p "$SAVE_DIR"
  SAVE_FILE="$SAVE_DIR/scan-$(date +%Y%m%d-%H%M%S).txt"
fi

run() {
  if $SAVE; then
    tee -a "$SAVE_FILE"
  else
    cat
  fi
}

WARN_COUNT=0
FAIL_COUNT=0

{
echo '=== RAJIUCE Security Scan ==='
echo "Date: $(date)"
echo ''

# -------------------------------------------------------------------
# 1. npm audit（node依存の脆弱性）
# -------------------------------------------------------------------
echo '--- [1] npm audit ---'
pnpm audit --production 2>&1 || true
echo ''

# -------------------------------------------------------------------
# 2. TypeScript strict check
# -------------------------------------------------------------------
echo '--- [2] TypeScript strict check ---'
pnpm typecheck 2>&1 || true
echo ''

# -------------------------------------------------------------------
# 3. ハードコードシークレット検出
# -------------------------------------------------------------------
echo '--- [3] Secrets leak check ---'
SECRET_HITS=$(grep -rn \
  'sk_live_\|sk_test_\|password\s*=\s*["'"'"'][^$]\|secret\s*=\s*["'"'"'][^$]\|PRIVATE_KEY\s*=\s*["'"'"']' \
  src/ admin-ui/src/ \
  --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null \
  | grep -v node_modules | grep -v '\.env' | grep -v '//' || true)

if [[ -n "$SECRET_HITS" ]]; then
  echo "[CRITICAL] Possible hardcoded secrets detected:"
  echo "$SECRET_HITS"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo '[PASS] No hardcoded secrets found'
fi
echo ''

# -------------------------------------------------------------------
# 4. SQLインジェクション簡易チェック
#    ※ parameterized query builder ($N 形式) は除外
# -------------------------------------------------------------------
echo '--- [4] SQL injection check ---'
SQL_HITS=$(grep -rn 'query.*\${' src/ --include='*.ts' 2>/dev/null \
  | grep -v node_modules \
  | grep -v '\$\${' \
  | grep -iE '(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|SET)\s' \
  | grep -v '\$[0-9]\|idx\|values\.length\|setClauses\|idParam\|placeholder' \
  || true)
if [[ -n "$SQL_HITS" ]]; then
  echo "[HIGH] Possible unsafe SQL string interpolation:"
  echo "$SQL_HITS"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo '[PASS] No unsafe SQL string interpolation found'
fi
echo ''

# -------------------------------------------------------------------
# 5. console.log 残留チェック（テストファイル除く）
# -------------------------------------------------------------------
echo '--- [5] console.log residual check ---'
CONSOLE_HITS=$(grep -rn 'console\.\(log\|debug\)' src/ --include='*.ts' 2>/dev/null \
  | grep -v node_modules | grep -v '\.test\.' | grep -v '__tests__' \
  | grep -v 'src/SCRIPTS/' || true)
if [[ -n "$CONSOLE_HITS" ]]; then
  echo "[WARN] console.log/debug found in src/ (non-test, non-script):"
  echo "$CONSOLE_HITS"
  WARN_COUNT=$((WARN_COUNT + 1))
else
  echo '[PASS] No console.log/debug in production src'
fi
echo ''

# -------------------------------------------------------------------
# 6. .env ファイルのgit追跡チェック
#    *.example ファイルはテンプレートなので除外
# -------------------------------------------------------------------
echo '--- [6] .env git tracking check ---'
ENV_TRACKED=$(git ls-files | grep '\.env' | grep -v '\.example$' | grep -v '\.bak$' 2>/dev/null || true)
ENV_BAK=$(git ls-files | grep '\.env\.bak' 2>/dev/null || true)

if [[ -n "$ENV_TRACKED" ]]; then
  echo "[CRITICAL] Non-example .env files tracked by git:"
  echo "$ENV_TRACKED"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo '[PASS] No non-example .env files tracked by git'
fi
if [[ -n "$ENV_BAK" ]]; then
  echo "[WARN] .env.bak tracked by git (may contain sensitive data):"
  echo "$ENV_BAK"
  WARN_COUNT=$((WARN_COUNT + 1))
fi
echo ''

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo '=== Scan Summary ==='
echo "CRITICAL/HIGH (FAIL): $FAIL_COUNT"
echo "WARN:                 $WARN_COUNT"
if [[ $FAIL_COUNT -gt 0 ]]; then
  echo 'Result: FAIL — Fix CRITICAL/HIGH issues before deploying'
  echo '=== Scan Complete ==='
  exit 1
else
  echo 'Result: PASS'
  echo '=== Scan Complete ==='
  exit 0
fi
} | run
