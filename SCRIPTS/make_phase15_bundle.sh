#!/usr/bin/env bash
set -euo pipefail

# このスクリプトはリポジトリ直下（commerce-faq-tasks）から実行される想定です。
# どこから実行しても動くように、まずプロジェクトルートに移動します。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATE_STR="$(date +%Y%m%d)"
OUT="phase15-context-${DATE_STR}.zip"

echo "[make_phase15_bundle] output: ${OUT}"

FILES=(
  # --- project level docs ---
  "README_PROJECT.md"
  "REQUIREMENTS.md"
  "ARCHITECTURE.md"
  "AGENTS.md"

  # --- phase14 docs ---
  "docs/PHASE14_SUMMARY.md"
  "docs/SALESFLOW_DESIGN.md"
  "docs/SALESFLOW_RUNTIME.md"
  "docs/INTENT_DETECTION_RULES.md"
  "docs/TUNING_TEMPLATES_WORKFLOW.md"
  "docs/SALES_LOG_SPEC.md"
  "docs/PERSONA_TAGS_REFERENCE.md"
  "docs/TEMPLATE_MATRIX.md"
  "docs/TEMPLATE_GAPS.md"

  # --- config ---
  "config/salesIntentRules.yaml"

  # --- scripts ---
  "SCRIPTS/generateTemplateMatrix.ts"
  "SCRIPTS/validateTuningTemplates.ts"
  "SCRIPTS/autoFillIntentSlugs.ts"

  # --- runtime core ---
  "src/index.ts"
  "src/agent/dialog"
  "src/agent/flow"
  "src/agent/sales"
  "src/integrations/notion"
  "src/repositories/tuningTemplateRepository.ts"
  "src/logging/salesLogWriter.ts"
)

# zip がない環境対策（macOS / Linux 想定）
if ! command -v zip >/dev/null 2>&1; then
  echo "Error: 'zip' command not found. Please install zip (e.g., 'brew install zip' or 'apt-get install zip')." >&2
  exit 1
fi

echo "[make_phase15_bundle] zipping files..."
zip -r "${OUT}" "${FILES[@]}"

echo "[make_phase15_bundle] done."
echo "Created: ${ROOT_DIR}/${OUT}"