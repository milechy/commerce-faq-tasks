#!/bin/bash
set -e
echo '=== RAJIUCE Security Scan ==='
echo 'Date:' $(date)
echo ''

# npm audit（node依存の脆弱性）
echo '--- npm audit ---'
pnpm audit --production 2>&1 || true
echo ''

# TypeScript strict check
echo '--- TypeScript strict check ---'
pnpm typecheck 2>&1 || true
echo ''

# .env漏洩チェック
echo '--- Secrets leak check ---'
grep -rn 'sk_live_\|sk_test_\|password\s*=' src/ admin-ui/src/ --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null | grep -v node_modules | grep -v '.env' || echo 'No secrets found in code'
echo ''

# SQLインジェクション簡易チェック
echo '--- SQL injection check ---'
grep -rn 'query.*\$\{' src/ --include='*.ts' 2>/dev/null | grep -v node_modules || echo 'No string interpolation in SQL'
echo ''

echo '=== Scan Complete ==='
