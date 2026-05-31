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
import subprocess, re, os

with open('/tmp/_dead_exports.txt') as f:
    lines = f.read().strip().split('\n')

# 参照探索のルート（リポジトリ全域）。
# 注意: テストは src/**/*.test.ts と トップレベル tests/ の両方に存在する。
# tests/ を含めないと test seam を誤って truly-dead 判定してしまう（実害: 削除でテスト破壊）。
roots = ['src/', 'SCRIPTS/', 'tests/']
if os.path.isdir('admin-ui/src'):
    roots.append('admin-ui/src/')

def ref_files(name):
    r = subprocess.run(
        ['grep', '-rIl', '--include=*.ts', '--include=*.tsx', '-w', '--', name] + roots,
        capture_output=True, text=True,
    )
    return [l for l in r.stdout.strip().split('\n') if l]

def in_file_uses(decl, name):
    r = subprocess.run(['grep', '-nw', '--', name, decl], capture_output=True, text=True)
    cnt = 0
    for l in r.stdout.strip().split('\n'):
        if not l:
            continue
        content = l.split(':', 1)[1] if ':' in l else l
        if re.search(r'\bexport\b', content):  # 宣言行は除外
            continue
        cnt += 1
    return cnt

cats = {'TRULY_DEAD': [], 'OVER_EXPORT': [], 'TEST_SEAM': [], 'SCRIPTS': [], 'ADMIN_UI': []}
for line in lines:
    if not line.strip():
        continue
    colon1 = line.index(':')
    colon2 = line.index(':', colon1 + 1)
    filepath = line[:colon1]
    content = line[colon2 + 1:]
    m = re.search(r'export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_][A-Za-z0-9_]*)', content)
    if not m:
        continue
    name = m.group(1)
    others = [f for f in ref_files(name) if f != filepath]
    src_nt = [f for f in others if f.startswith('src/') and '.test.' not in f]
    # テスト参照: src/**/*.test.ts と トップレベル tests/ の両方を test seam とみなす。
    src_t = [f for f in others if (f.startswith('src/') and '.test.' in f) or f.startswith('tests/')]
    scr = [f for f in others if f.startswith('SCRIPTS/')]
    adm = [f for f in others if f.startswith('admin-ui/')]
    if src_nt:
        continue  # 実際に他の本番ファイルから使われている → dead ではない
    if scr:
        cats['SCRIPTS'].append((filepath, name))       # SCRIPTS/ が消費 → 保持
    elif adm:
        cats['ADMIN_UI'].append((filepath, name))      # admin-ui が消費 → 保持
    elif src_t:
        cats['TEST_SEAM'].append((filepath, name))     # テストseam → 保持（export 妥当）
    elif in_file_uses(filepath, name) > 0:
        cats['OVER_EXPORT'].append((filepath, name))   # 同ファイル内使用のみ → export を外せる
    else:
        cats['TRULY_DEAD'].append((filepath, name))    # 全域で未参照 → 削除候補

# TRULY_DEAD のみを「警告対象」とし、他は参考情報として静かに分類する。
for fp, nm in cats['TRULY_DEAD']:
    print(f"  ⚠️  {fp} → {nm}")
print(f"__DEAD_COUNT__:{len(cats['TRULY_DEAD'])}")
print(f"__INFO__:OVER_EXPORT={len(cats['OVER_EXPORT'])} (export を外せる) | "
      f"TEST_SEAM={len(cats['TEST_SEAM'])} (テスト専用・保持) | "
      f"SCRIPTS={len(cats['SCRIPTS'])} (SCRIPTS/消費・保持) | "
      f"ADMIN_UI={len(cats['ADMIN_UI'])} (admin-ui消費・保持)")
PYEOF
)

rm -f /tmp/_dead_exports.txt

DEAD_COUNT=$(echo "$DEAD_RESULT" | grep "__DEAD_COUNT__:" | sed 's/__DEAD_COUNT__://')
DEAD_INFO=$(echo "$DEAD_RESULT" | grep "__INFO__:" | sed 's/__INFO__://')
echo "$DEAD_RESULT" | grep -vE "__DEAD_COUNT__:|__INFO__:" || true

echo ""
if [ "${DEAD_COUNT:-0}" -gt 0 ]; then
  echo "⚠️  Found $DEAD_COUNT truly-dead export(s) — 全リポジトリ(src/SCRIPTS/admin-ui/test/同ファイル)で未参照"
  echo "   削除前に「未配線の機能」でないか確認すること（DB書込み等の意図的実装の可能性）。"
else
  echo "✅ No truly-dead exports detected"
fi
if [ -n "$DEAD_INFO" ]; then
  echo "   分類(保持OK/警告対象外): $DEAD_INFO"
fi

# ── 2. 未登録ルート ────────────────────────────────────────────────────────
echo ""
echo "--- Unregistered Route Files ---"

UNREGISTERED=0
while IFS= read -r route_file; do
  base=$(basename "$route_file" .ts)
  # src/index.ts に直接登録、または他の *.ts ファイルから import されているか確認
  ref_count=$(grep -rn --include="*.ts" -- "$base" src/ 2>/dev/null | grep -v "^${route_file}:" | wc -l)
  if [ "${ref_count// /}" = "0" ]; then
    echo "  ⚠️  $route_file (no references found outside itself in src/)"
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
