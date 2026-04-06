#!/bin/bash
# SCRIPTS/dead-code-check.sh
# 孤立コード（エクスポートされているが未参照）を検出
# 使用: bash SCRIPTS/dead-code-check.sh
# 終了コード: 0 (warning-only — CIをブロックしない)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Dead Code Check ($(date '+%Y-%m-%d %H:%M:%S')) ==="
echo ""

# ── 1. 未参照エクスポート（Python3で正確に検出）──────────────────────────
echo "--- Unused Exports ---"

# grep -v でテストファイルを除外、type/interface は対象外
grep -rn "^export function\|^export const\|^export class\|^export async function" \
  src/ --include="*.ts" | grep -v "\.test\.ts:" > /tmp/_dead_exports.txt 2>/dev/null || true

DEAD_RESULT=$(python3 - << 'PYEOF'
import subprocess, re, sys

with open('/tmp/_dead_exports.txt') as f:
    lines = f.read().strip().split('\n')

dead = []
for line in lines:
    if not line.strip():
        continue
    # filepath:linenum:content
    colon1 = line.index(':')
    colon2 = line.index(':', colon1 + 1)
    filepath = line[:colon1]
    content  = line[colon2+1:]
    # extract exported symbol name
    m = re.search(
        r'export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_][A-Za-z0-9_]*)',
        content
    )
    if not m:
        continue
    name = m.group(1)
    # count references in src/ outside the declaring file
    result = subprocess.run(
        ['grep', '-rn', '--include=*.ts', '--', name, 'src/'],
        capture_output=True, text=True
    )
    refs = [l for l in result.stdout.strip().split('\n')
            if l and not l.startswith(filepath + ':')]
    if not refs:
        dead.append(f"  ⚠️  {filepath} → {name}")

for d in dead:
    print(d)
print(f"__DEAD_COUNT__:{len(dead)}")
PYEOF
)

rm -f /tmp/_dead_exports.txt

DEAD_COUNT=$(echo "$DEAD_RESULT" | grep "__DEAD_COUNT__:" | sed 's/__DEAD_COUNT__://')
echo "$DEAD_RESULT" | grep -v "__DEAD_COUNT__:" || true

echo ""
if [ "${DEAD_COUNT:-0}" -gt 0 ]; then
  echo "⚠️  Found $DEAD_COUNT potentially unused export(s)"
  echo "   NOTE: false positives possible (runtime catch clauses, external callers, etc.)"
  echo "   Review manually before deleting."
else
  echo "✅ No dead exports detected"
fi

# ── 2. 未登録ルート ────────────────────────────────────────────────────────
echo ""
echo "--- Unregistered Route Files ---"

UNREGISTERED=0
while IFS= read -r route_file; do
  base=$(basename "$route_file" .ts)
  # src/index.ts に直接登録、または他の *.ts ファイルから import されているか確認
  refs=$(grep -rn --include="*.ts" -- "$base" src/ 2>/dev/null | grep -v "^${route_file}:" | grep -c "" || echo "0")
  if [ "$refs" = "0" ]; then
    echo "  ⚠️  $route_file (no references found in src/)"
    UNREGISTERED=$((UNREGISTERED + 1))
  fi
done < <(find src/api/ -name "*.ts" | grep -i "routes\|router" | grep -v "\.test\.ts" || true)

if [ "$UNREGISTERED" -eq 0 ]; then
  echo "  ✅ All route files appear to be registered"
fi

# ── 3. 循環依存チェック（madge が利用可能な場合）──────────────────────────
echo ""
echo "--- Circular Dependencies ---"
if command -v npx &>/dev/null; then
  CIRCULAR=$(npx madge --circular src/index.ts 2>/dev/null || echo "")
  if echo "$CIRCULAR" | grep -q "^[0-9]"; then
    echo "$CIRCULAR" | head -10
    echo "  ⚠️  Circular dependencies detected (see above)"
  else
    echo "  ✅ No circular dependencies (or madge unavailable)"
  fi
else
  echo "  ℹ️  npx not found, skipping circular dependency check"
fi

# ── 4. 結果サマリー ────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
echo "  Dead exports:        ${DEAD_COUNT:-0} (warning only)"
echo "  Unregistered routes: $UNREGISTERED (warning only)"
echo ""
echo "  ℹ️  See docs/CODE_HEALTH_REPORT.md for full analysis"

# warning-only — CIブロックはしない（初回は様子見）
exit 0
