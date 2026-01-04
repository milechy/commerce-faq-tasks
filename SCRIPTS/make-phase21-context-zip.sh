#!/usr/bin/env bash
set -euo pipefail

# Phase21 context zip generator
# - Collects an allowlisted set of files (tracked only)
# - Adds lightweight git diagnostics (status/diff/log/head)
# - Produces phase21-context-YYYYMMDD.zip at repo root

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

DATE="$(date +%Y%m%d)"
OUT_ZIP="phase21-context-${DATE}.zip"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

# --- Allowlist (edit as needed) ---
# Keep this tight: Phase21 is about partner verification + external avatar API support.
ALLOWLIST=(
  "PHASE20.md"
  "PHASE19.md"
  "PHASE19_UI_SPEC.md"
  "PHASE21.md"

  "public/ui/index.html"
  "src/index.ts"
  "src/agent/http/agentSearchRoute.ts"

  "ENVIRONMENT.md"
  "README_PROJECT.md"
  "ARCHITECTURE.md"

  "docs/LOGGING_SCHEMA.md"
  "docs/P95_METRICS.md"
  "docs/search-pipeline.md"

  "tests/agent/httpAgent.smoke.ts"
)

# Optional: include entire directories if they exist (still filtered to tracked files)
OPTIONAL_DIRS=(
  "src/search"
  "src/integration"
  "src/integrations"
  "src/repositories"
  "src/agent/logging"
)

# --- Collect files ---
mkdir -p "$STAGE_DIR/repo"

copy_tracked() {
  local path="$1"
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    mkdir -p "$STAGE_DIR/repo/$(dirname "$path")"
    cp -p "$path" "$STAGE_DIR/repo/$path"
  fi
}

copy_tracked_dir() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    # Only tracked files under dir
    while IFS= read -r f; do
      mkdir -p "$STAGE_DIR/repo/$(dirname "$f")"
      cp -p "$f" "$STAGE_DIR/repo/$f"
    done < <(git ls-files "$dir")
  fi
}

for f in "${ALLOWLIST[@]}"; do
  copy_tracked "$f"
done

for d in "${OPTIONAL_DIRS[@]}"; do
  copy_tracked_dir "$d"
done

# --- Git diagnostics (Phase21 design often needs these) ---
mkdir -p "$STAGE_DIR/git"

git rev-parse HEAD > "$STAGE_DIR/git/HEAD.txt"
git branch --show-current > "$STAGE_DIR/git/branch.txt" || true
git status --porcelain=v1 > "$STAGE_DIR/git/status_porcelain.txt" || true
git status > "$STAGE_DIR/git/status.txt" || true
git log -n 30 --oneline --decorate > "$STAGE_DIR/git/log_oneline.txt" || true

# Include diff only if exists (kept small; if huge, it will still zip but may be noisy)
if ! git diff --quiet; then
  git diff > "$STAGE_DIR/git/working_tree.diff" || true
fi

if ! git diff --cached --quiet; then
  git diff --cached > "$STAGE_DIR/git/index.diff" || true
fi

# --- Build zip ---
# Use (cd) to avoid embedding temp absolute paths
(
  cd "$STAGE_DIR"
  # -q: quiet, -r: recursive
  zip -qr "$ROOT/$OUT_ZIP" repo git
)

echo "Created: $OUT_ZIP"
echo "Included files:"
(
  cd "$STAGE_DIR/repo"
  find . -type f | sed 's|^\./||' | sort
)
