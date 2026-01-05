#!/usr/bin/env bash
set -euo pipefail

# Phase22 context zip generator (repo-aligned)
# - Uses git ls-files to collect relevant sources
# - Excludes secrets, snapshots, large artifacts, logs, and models
#
# Usage:
#   bash SCRIPTS/make-phase22-context-zip.sh
#   OUT=phase22_context.zip bash SCRIPTS/make-phase22-context-zip.sh
#   INCLUDE_ADMIN_UI=1 bash SCRIPTS/make-phase22-context-zip.sh

OUT="${OUT:-phase22_context.zip}"
INCLUDE_ADMIN_UI="${INCLUDE_ADMIN_UI:-0}"

TMPDIR="$(mktemp -d)"
MANIFEST_RAW="${TMPDIR}/manifest_raw.txt"
MANIFEST="${TMPDIR}/manifest.txt"

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "== Phase22 context zip =="
echo "OUT=${OUT}"
echo "INCLUDE_ADMIN_UI=${INCLUDE_ADMIN_UI}"

# Safety: must be inside a git repo
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "ERROR: not inside a git repository."
  exit 1
}

# 1) Start from all tracked files
git ls-files > "$MANIFEST_RAW"

# 2) Exclude rules (fixed)
# - secrets
# - snapshots/context bundles
# - generated zips
# - heavy models, logs
# - admin-ui (optional include)
# - other nonessential noise
grep -vE '(^|/)\.env(\..*)?$' "$MANIFEST_RAW" | \
grep -vE '(^|/)\.env\.bak$' | \
grep -vE '\.zip$' | \
grep -vE '^(logs/|models/)' | \
grep -vE '^(commerce-faq-phase7-minimal/|phase12-context/|phase12-context 2/)' | \
grep -vE '^admin-ui/' | \
cat > "$MANIFEST"

# Optionally include admin-ui
if [[ "$INCLUDE_ADMIN_UI" == "1" ]]; then
  echo "Including admin-ui/**"
  # Rebuild manifest without excluding admin-ui
  grep -vE '(^|/)\.env(\..*)?$' "$MANIFEST_RAW" | \
  grep -vE '(^|/)\.env\.bak$' | \
  grep -vE '\.zip$' | \
  grep -vE '^(logs/|models/)' | \
  grep -vE '^(commerce-faq-phase7-minimal/|phase12-context/|phase12-context 2/)' | \
  cat > "$MANIFEST"
fi

# 3) Now restrict to Phase22-relevant scope (whitelist approach)
# Keep:
# - phase docs + architecture + clarify specs
# - docs/*
# - src/*
# - tests/*
# - config/*
# - SCRIPTS/*
# - CI/workflows + configs
# - top-level build files
awk '
  BEGIN { keep=0 }
  {
    f=$0
    keep = 0

    # Top-level must-have docs
    if (f ~ /^(PHASE20\.md|PHASE21\.md|PHASE22\.md|PHASE_ROADMAP\.md)$/) keep=1
    if (f ~ /^(REQUIREMENTS\.md|ARCHITECTURE\.md|DEV_ARCHITECTURE\.md|AGENTS\.md|README_PROJECT\.md|README\.md|ENVIRONMENT\.md)$/) keep=1
    if (f ~ /^(CLARIFY_FLOW\.md|CLARIFY_LOG_SPEC\.md|SALES_TEMPLATE_PROVIDER\.md|TUNING_TEMPLATES_SPEC\.md|TASKS\.md)$/) keep=1

    # Docs directory (design/spec source of truth)
    if (f ~ /^docs\//) keep=1

    # Code + tests
    if (f ~ /^src\//) keep=1
    if (f ~ /^tests\//) keep=1
    if (f ~ /^config\//) keep=1

    # Scripts
    if (f ~ /^SCRIPTS\//) keep=1

    # CI + env examples
    if (f ~ /^\.github\/workflows\//) keep=1
    if (f ~ /^\.devcontainer\//) keep=1
    if (f ~ /^docker-compose\.yml$/) keep=1
    if (f ~ /^Dockerfile$/) keep=1
    if (f ~ /^\.env\.example$/) keep=1

    # Node build/test configs
    if (f ~ /^(package\.json|pnpm-lock\.yaml|tsconfig\.json|jest\.config\.cjs)$/) keep=1

    if (keep==1) print f
  }
' "$MANIFEST" | sort -u > "${TMPDIR}/manifest_final.txt"

# 4) Final safety: do not include any env files accidentally
grep -vE '(^|/)\.env(\..*)?$' "${TMPDIR}/manifest_final.txt" > "${TMPDIR}/manifest_sanitized.txt"

if [[ ! -s "${TMPDIR}/manifest_sanitized.txt" ]]; then
  echo "ERROR: manifest is empty after filtering."
  exit 1
fi

echo "Files included: $(wc -l < "${TMPDIR}/manifest_sanitized.txt")"
echo "Preview (first 40):"
head -n 40 "${TMPDIR}/manifest_sanitized.txt" | sed 's/^/  - /'

# 5) Create zip (or tar.gz fallback)
if command -v zip >/dev/null 2>&1; then
  zip -q -r "$OUT" -@ < "${TMPDIR}/manifest_sanitized.txt"
  echo "Done: ${OUT}"
else
  OUT_TGZ="${OUT%.zip}.tar.gz"
  tar -czf "$OUT_TGZ" -T "${TMPDIR}/manifest_sanitized.txt"
  echo "zip not found; created: ${OUT_TGZ}"
fi
