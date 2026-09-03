#!/bin/bash
# RAJIUCE Security Scan Script
# Usage: bash SCRIPTS/security-scan.sh [--save]
#
# CI と判定基準を完全に揃える:
#   - pnpm audit は --audit-level=high で評価する。判定は SCRIPTS/audit-check.sh に
#     一本化し、「脆弱性あり(FAIL)」と「レジストリ不通で検査できず(WARN)」を区別する
#     (旧仕様は非ゼロを一律 FAIL にしていた)
#   - ignore 対象 CVE は package.json#pnpm.auditConfig.ignoreCves で集中管理
#     (根拠と再評価条件は docs/SECURITY_SCAN_ALLOWLIST.md に記録)

# 中の `{ ... } | tee` パターンでも内側ブロックの exit 1 を script 全体に伝播させる
set -o pipefail

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
#    CIの独立auditステップ (.github/workflows/security-scan.yml) と同一基準:
#      pnpm audit --production --audit-level=high
#    ignore 対象 CVE は package.json#pnpm.auditConfig.ignoreCves で集中管理
# -------------------------------------------------------------------
echo '--- [1] npm audit (--audit-level=high) ---'
# 判定は SCRIPTS/audit-check.sh に一本化する(実装を2箇所に持たない)。
# 「脆弱性を検出した」と「レジストリへ到達できなかった」を区別するため。
# 従来はどちらも FAIL にしていたので、npm 側が不通になるたびに無関係な PR の
# マージが止まり、かつ FAIL の意味が薄まっていた(Asana 1218165546985984)。
AUDIT_OUTPUT=$(bash "$(dirname "$0")/audit-check.sh" 2>&1)
AUDIT_RC=$?
echo "$AUDIT_OUTPUT"
AUDIT_STATUS=$(echo "$AUDIT_OUTPUT" | grep -o 'AUDIT_STATUS=[a-z_]*' | tail -1 | cut -d= -f2)
if [[ $AUDIT_RC -ne 0 ]]; then
  # audit-check.sh が非ゼロを返すのは vulnerable のときだけ(判別不能も含む)。
  FAIL_COUNT=$((FAIL_COUNT + 1))
elif [[ "$AUDIT_STATUS" == "not_checked" ]]; then
  # ★黙って PASS にしない★ 検査できていないことをサマリにも残す。
  WARN_COUNT=$((WARN_COUNT + 1))
fi
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

# DB/broker 接続文字列にインラインで書かれた平文パスワード
#   例: postgresql://postgres:<20桁実PW>@127.0.0.1:5432/commerce_faq
# gitleaks の db-connection-string-password ルールと同種の穴を、自前 grep 側でも塞ぐ。
# 実漏洩はホストが 127.0.0.1 だったため *ホストでは除外しない*。除外はパスワードが
# プレースホルダ/明示ダミー (<...> / ${...} / pass / changeme 等) の場合のみ。
DB_CONNSTR_HITS=$(grep -rnoE \
  '(postgres(ql)?|mysql|mongodb(\+srv)?|rediss?|amqps?)://[^:@/[:space:]]+:[^@/[:space:]]{5,}@[^[:space:]"'"'"'`]+' \
  src/ admin-ui/src/ \
  --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null \
  | grep -v node_modules \
  | grep -vEi '://[^@]+:(<[^>]*>|\$\{[^}]*\}|pass|password|passwd|postgres|postgresql|mysql|mongo|root|admin|user|guest|changeme|change[_-]me|secret|example|test|dummy|placeholder|sample|redacted|your[_-][a-z]*|replace[_-]?me|xxx+|yyy+|zzz+)@' \
  || true)

if [[ -n "$DB_CONNSTR_HITS" ]]; then
  echo "[CRITICAL] Possible DB connection-string password (plaintext) detected:"
  echo "$DB_CONNSTR_HITS"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo '[PASS] No inline DB connection-string passwords found'
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

echo '--- [7] Groq EOL model check ---'
if [[ -f "$(dirname "$0")/check-groq-models.sh" ]]; then
  if bash "$(dirname "$0")/check-groq-models.sh" >/tmp/groq_eol_check.txt 2>&1; then
    echo '[PASS] No decommissioned Groq model IDs in src/'
  else
    echo '[CRITICAL] Decommissioned Groq model ID(s) referenced in src/:'
    grep -E 'DEPRECATED MODEL IN USE|src/' /tmp/groq_eol_check.txt || cat /tmp/groq_eol_check.txt
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo '[WARN] check-groq-models.sh not found, skipping'
fi
echo ''

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo '=== Scan Summary ==='
# 依存監査を「実行できたか」を必ず明示する。PASS の一言に紛れると、
# 検査できていない期間が常態化しても誰も気づけない。
echo "AUDIT:                ${AUDIT_STATUS:-unknown}"
if [[ "$AUDIT_STATUS" == "not_checked" ]]; then
  echo '  ↑ 依存の脆弱性は今回検査できていません(レジストリ不通)。'
  echo '    依存を変更した PR では、到達可能になってから再確認すること。'
fi
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
