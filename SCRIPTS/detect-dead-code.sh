#!/usr/bin/env bash
# detect-dead-code.sh — Dead code / unused dependency detection
# Run from project root: bash SCRIPTS/detect-dead-code.sh
set -uo pipefail

REPORT="SCRIPTS/dead-code-report.txt"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Counters
COUNT_CRITICAL=0
COUNT_HIGH=0
COUNT_MEDIUM=0
COUNT_LOW=0

# ─── helpers ────────────────────────────────────────────────────────────────
section() {
  echo "" >> "$REPORT"
  echo "============================================================" >> "$REPORT"
  echo "$1" >> "$REPORT"
  echo "============================================================" >> "$REPORT"
}

# ─── initialise report ──────────────────────────────────────────────────────
mkdir -p "$(dirname "$REPORT")"
{
  echo "DEAD CODE DETECTION REPORT"
  echo "Generated: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "Project: $PROJECT_ROOT"
} > "$REPORT"

# ============================================================
# CHECK 1: TypeScript 未使用export (ts-prune) [HIGH]
# ============================================================
section "=== CHECK 1: TypeScript未使用export (ts-prune) === [HIGH]"

if npx --yes ts-prune --version >/dev/null 2>&1 || true; then
  echo "Running ts-prune on src/ ..." >> "$REPORT"
  TSPRUNE_OUT=$(npx --yes ts-prune 2>/dev/null | grep -v "\.test\.ts" || true)
  if [ -n "$TSPRUNE_OUT" ]; then
    echo "$TSPRUNE_OUT" >> "$REPORT"
    COUNT_HIGH=$(echo "$TSPRUNE_OUT" | grep -c "." || true)
  else
    echo "(no unused exports found)" >> "$REPORT"
    COUNT_HIGH=0
  fi
else
  echo "[SKIP] ts-prune could not be installed/run" >> "$REPORT"
fi

# ============================================================
# CHECK 2: Admin UI 未使用コンポーネント [MEDIUM]
# ============================================================
section "=== CHECK 2: Admin UI未使用コンポーネント === [MEDIUM]"

UNUSED_COMPONENTS=()

if [ -d "admin-ui/src/components" ] || [ -d "admin-ui/src/pages" ]; then
  # Collect all component/page files
  while IFS= read -r -d '' filepath; do
    filename=$(basename "$filepath")
    # Strip extension(s): .tsx, .ts, .jsx, .js
    basename_no_ext="${filename%.*}"
    # Skip index files — they are barrel exports, not components themselves
    if [ "$basename_no_ext" = "index" ]; then
      continue
    fi
    # Search for any import of this name in admin-ui/src (including lazy imports)
    # Match: import Foo from, import { Foo }, import(...'Foo), etc.
    if ! grep -rq "$basename_no_ext" admin-ui/src/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" 2>/dev/null; then
      UNUSED_COMPONENTS+=("$filepath")
    fi
  done < <(find admin-ui/src/components admin-ui/src/pages -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.jsx" -o -name "*.js" \) -print0 2>/dev/null)

  if [ ${#UNUSED_COMPONENTS[@]} -eq 0 ]; then
    echo "(no unused components found)" >> "$REPORT"
  else
    for f in "${UNUSED_COMPONENTS[@]}"; do
      echo "UNUSED: $f" >> "$REPORT"
    done
    COUNT_MEDIUM=$((COUNT_MEDIUM + ${#UNUSED_COMPONENTS[@]}))
  fi
else
  echo "[SKIP] admin-ui/src/components or admin-ui/src/pages not found" >> "$REPORT"
fi

# ============================================================
# CHECK 3: 未使用npm依存 (depcheck) [MEDIUM]
# ============================================================
section "=== CHECK 3: 未使用npm依存 (depcheck) === [MEDIUM]"

DEPCHECK_MEDIUM=0

echo "--- Root package.json ---" >> "$REPORT"
if ROOT_DC=$(npx --yes depcheck --skip-missing 2>/dev/null); then
  # Extract unused dependencies section
  UNUSED_SECTION=$(echo "$ROOT_DC" | awk '/^Unused dependencies/,/^(Missing|Unused devDependencies|$)/' | grep -v "^$" | grep -v "^Missing" | grep -v "^Unused devDependencies" || true)
  UNUSED_DEV_SECTION=$(echo "$ROOT_DC" | awk '/^Unused devDependencies/,/^(Missing|$)/' | grep -v "^$" | grep -v "^Missing" || true)
  if [ -n "$UNUSED_SECTION" ] || [ -n "$UNUSED_DEV_SECTION" ]; then
    echo "$ROOT_DC" >> "$REPORT"
    DEPCHECK_MEDIUM=$((DEPCHECK_MEDIUM + $(echo "$ROOT_DC" | grep -c "^\* " || true)))
  else
    echo "(no unused dependencies in root)" >> "$REPORT"
  fi
else
  echo "[SKIP] depcheck failed for root package.json" >> "$REPORT"
fi

echo "" >> "$REPORT"
echo "--- admin-ui/package.json ---" >> "$REPORT"
if [ -f "admin-ui/package.json" ]; then
  if ADMINUI_DC=$(cd admin-ui && npx --yes depcheck --skip-missing 2>/dev/null); then
    if echo "$ADMINUI_DC" | grep -q "^\* "; then
      echo "$ADMINUI_DC" >> "$REPORT"
      DEPCHECK_MEDIUM=$((DEPCHECK_MEDIUM + $(echo "$ADMINUI_DC" | grep -c "^\* " || true)))
    else
      echo "(no unused dependencies in admin-ui)" >> "$REPORT"
    fi
  else
    echo "[SKIP] depcheck failed for admin-ui/package.json" >> "$REPORT"
  fi
else
  echo "[SKIP] admin-ui/package.json not found" >> "$REPORT"
fi

COUNT_MEDIUM=$((COUNT_MEDIUM + DEPCHECK_MEDIUM))

# ============================================================
# CHECK 4: 未到達APIエンドポイント [CRITICAL]
# ============================================================
section "=== CHECK 4: 未到達APIエンドポイント === [CRITICAL]"

# Internal/infrastructure paths to always exclude
EXCLUDE_PATHS=(
  "/health"
  "/metrics"
  "/status"
  "/internal"
  "/ce/status"
  "/ce/warmup"
  "/ui"
  "/widget.js"
)

# ── 4a. Extract backend route paths ──────────────────────────────────────────
# Collect route files: src/index.ts + src/**/*Route.ts + src/**/*route.ts
ROUTE_FILES=()
ROUTE_FILES+=("src/index.ts")
while IFS= read -r -d '' f; do
  ROUTE_FILES+=("$f")
done < <(find src -type f \( -name "*Route.ts" -o -name "*route.ts" -o -name "*Routes.ts" -o -name "*routes.ts" \) -print0 2>/dev/null)

BACKEND_PATHS=()
for rfile in "${ROUTE_FILES[@]}"; do
  [ -f "$rfile" ] || continue
  # Match patterns: app.METHOD("/path", ...) and router.METHOD("/path", ...)
  # Capture the first string literal argument
  while IFS= read -r line; do
    # Extract path from: app.get("/foo", ...) or router.post('/foo/bar', ...)
    # Use perl for ERE compatibility across macOS and Linux
    path=$(echo "$line" | perl -nE 'if (/\.(get|post|put|delete|patch)\s*\(\s*["'"'"']([^"'"'"']+)["'"'"']/) { print "$2\n" }')
    if [ -n "$path" ]; then
      BACKEND_PATHS+=("$path")
    fi
  done < <(grep -E '\.(get|post|put|delete|patch)\s*\(' "$rfile" 2>/dev/null || true)
done

# Deduplicate
mapfile -t BACKEND_PATHS < <(printf '%s\n' "${BACKEND_PATHS[@]}" | sort -u)

echo "Backend routes found: ${#BACKEND_PATHS[@]}" >> "$REPORT"

# ── 4b. Extract paths called from frontend ────────────────────────────────────
FRONTEND_CALLS=()

# Scan admin-ui/src for fetch/authFetch/adminFetch/axios calls
while IFS= read -r line; do
  # Match: authFetch(`${API_BASE}/foo`), fetch("http://..."), etc.
  # Extract path segments that look like /v1/... /api/... /admin/...
  while IFS= read -r match; do
    FRONTEND_CALLS+=("$match")
  done < <(echo "$line" | grep -oE '"(/[^"]+)"' | tr -d '"' || true)
  while IFS= read -r match; do
    FRONTEND_CALLS+=("$match")
  done < <(echo "$line" | grep -oE "'(/[^']+)'" | tr -d "'" || true)
  # Template literals: `${API_BASE}/foo/bar`
  while IFS= read -r match; do
    FRONTEND_CALLS+=("$match")
  done < <(echo "$line" | grep -oE '\$\{[A-Z_]+\}(/[^`"'"'"' )]+)' | sed 's/\${[^}]*}//' || true)
done < <(grep -rE '(authFetch|adminFetch|fetch|axios\.|api\.get|api\.post|api\.put|api\.delete|api\.patch)\s*\(' admin-ui/src/ --include="*.ts" --include="*.tsx" 2>/dev/null || true)

# Also scan widget.js
while IFS= read -r line; do
  while IFS= read -r match; do
    FRONTEND_CALLS+=("$match")
  done < <(echo "$line" | grep -oE '"(/[^"]+)"' | tr -d '"' || true)
  while IFS= read -r match; do
    FRONTEND_CALLS+=("$match")
  done < <(echo "$line" | grep -oE "'(/[^']+)'" | tr -d "'" || true)
done < <(grep -E '(fetch|axios)\s*\(' public/widget.js 2>/dev/null || true)

# Normalise: strip query strings and trailing slashes
NORMALISED_CALLS=()
for c in "${FRONTEND_CALLS[@]}"; do
  c="${c%%\?*}"   # strip query string
  c="${c%/}"      # strip trailing slash
  [ -n "$c" ] && NORMALISED_CALLS+=("$c")
done
mapfile -t NORMALISED_CALLS < <(printf '%s\n' "${NORMALISED_CALLS[@]}" | sort -u)

echo "Frontend call paths found: ${#NORMALISED_CALLS[@]}" >> "$REPORT"

# ── 4c. Find unreachable backend paths ───────────────────────────────────────
UNREACHABLE=()

for bpath in "${BACKEND_PATHS[@]}"; do
  # Skip excluded infrastructure paths
  skip=false
  for excl in "${EXCLUDE_PATHS[@]}"; do
    if [[ "$bpath" == "$excl" ]] || [[ "$bpath" == /internal* ]]; then
      skip=true
      break
    fi
  done
  $skip && continue

  # Skip paths with route params (e.g. /v1/admin/tenants/:id) — check prefix
  bpath_prefix="${bpath%%:*}"
  bpath_prefix="${bpath_prefix%/}"

  found=false
  for fcall in "${NORMALISED_CALLS[@]}"; do
    # Exact match or prefix match (frontend may call /v1/admin/tenants/123)
    if [[ "$fcall" == "$bpath" ]] || [[ "$fcall" == "$bpath_prefix"* ]]; then
      found=true
      break
    fi
    # Also check if backend path prefix matches a frontend call
    if [[ -n "$bpath_prefix" ]] && [[ "$fcall" == "$bpath_prefix" ]]; then
      found=true
      break
    fi
  done

  if ! $found; then
    # Also grep the raw path string anywhere in admin-ui/src or widget.js
    clean_path="${bpath%%/:*}"  # strip param portion for grep
    if grep -rq "$clean_path" admin-ui/src/ public/widget.js 2>/dev/null; then
      found=true
    fi
  fi

  if ! $found; then
    UNREACHABLE+=("$bpath")
  fi
done

if [ ${#UNREACHABLE[@]} -eq 0 ]; then
  echo "(no obviously unreachable endpoints detected)" >> "$REPORT"
else
  echo "" >> "$REPORT"
  echo "Potentially unreachable backend endpoints (not called from admin-ui or widget):" >> "$REPORT"
  for p in "${UNREACHABLE[@]}"; do
    echo "  UNREACHABLE: $p" >> "$REPORT"
  done
  COUNT_CRITICAL=${#UNREACHABLE[@]}
fi

# ============================================================
# CHECK 5: 孤立テストファイル [LOW]
# ============================================================
section "=== CHECK 5: 孤立テストファイル === [LOW]"

ORPHANED_TESTS=()

while IFS= read -r -d '' testfile; do
  # Derive base name (without .test.ts / .test.js / .spec.ts etc.)
  filename=$(basename "$testfile")
  # Strip test/spec suffix
  base="${filename%.test.ts}"
  base="${base%.test.js}"
  base="${base%.spec.ts}"
  base="${base%.spec.js}"
  base="${base%.test.tsx}"
  base="${base%.spec.tsx}"

  # Case-insensitive search for source file in src/
  if ! find src/ -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) \
       -iname "*${base}*" ! -name "*.test.*" ! -name "*.spec.*" 2>/dev/null | grep -q .; then
    ORPHANED_TESTS+=("$testfile")
  fi
done < <(find tests/ -type f \( -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" \) -print0 2>/dev/null)

if [ ${#ORPHANED_TESTS[@]} -eq 0 ]; then
  echo "(no orphaned test files found)" >> "$REPORT"
else
  for t in "${ORPHANED_TESTS[@]}"; do
    echo "ORPHANED: $t" >> "$REPORT"
  done
  COUNT_LOW=${#ORPHANED_TESTS[@]}
fi

# ============================================================
# SUMMARY
# ============================================================
section "=== SUMMARY ==="
{
  echo "CRITICAL (未到達エンドポイント): $COUNT_CRITICAL"
  echo "HIGH     (未使用export):        $COUNT_HIGH"
  echo "MEDIUM   (未使用依存/コンポーネント): $COUNT_MEDIUM"
  echo "LOW      (孤立テスト):          $COUNT_LOW"
} >> "$REPORT"

echo ""
echo "========================================"
echo "DEAD CODE DETECTION SUMMARY"
echo "========================================"
printf "CRITICAL: 未到達エンドポイント %d件\n" "$COUNT_CRITICAL"
printf "HIGH:     未使用export %d件\n" "$COUNT_HIGH"
printf "MEDIUM:   未使用依存 %d件\n" "$COUNT_MEDIUM"
printf "LOW:      孤立テスト %d件\n" "$COUNT_LOW"
echo "========================================"
echo ""
echo "Full report: $PROJECT_ROOT/$REPORT"
