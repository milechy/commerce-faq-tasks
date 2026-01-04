#!/usr/bin/env bash
set -euo pipefail

show_help() {
  cat <<'EOF'
Usage:
  SCRIPTS/make_phase16_context_zip.sh [--date YYYYMMDD] [--out DIR] [--dry-run]

Options:
  --date YYYYMMDD   ZIP ファイル名に使う日付 (default: today)
  --out DIR         出力ディレクトリ (default: プロジェクトルート)
  --dry-run         実際にはコピー/ZIP せず、対象ファイルだけ表示
EOF
}

DATE="$(date +%Y%m%d)"
OUT_DIR=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date)
      DATE="$2"
      shift 2
      ;;
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      show_help
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$PROJECT_ROOT"
fi

ZIP_NAME="phase16-context-${DATE}.zip"
OUT_ZIP="${OUT_DIR%/}/${ZIP_NAME}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/phase16-context-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$PROJECT_ROOT"

# Phase16 コンテキストに含めるパス一覧
INCLUDE_PATHS=(
  "README_PROJECT.md"

  "docs/PHASE14_SUMMARY.md"
  "docs/PHASE15_SUMMARY.md"
  "docs/SALESFLOW_DESIGN.md"
  "docs/SALESFLOW_RUNTIME.md"
  "docs/INTENT_DETECTION_RULES.md"
  "docs/SALES_LOG_SPEC.md"
  "docs/TUNING_TEMPLATES_WORKFLOW.md"
  "docs/SALES_ANALYTICS.md"

  "config/salesIntentRules.yaml"

  "src/agent/dialog/dialogAgent.ts"
  "src/agent/dialog/salesContextStore.ts"

  "src/agent/orchestrator/sales/closePromptBuilder.ts"
  "src/agent/orchestrator/sales/proposePromptBuilder.ts"
  "src/agent/orchestrator/sales/recommendPromptBuilder.ts"
  "src/agent/orchestrator/sales/salesIntentDetector.ts"
  "src/agent/orchestrator/sales/salesStageMachine.ts"
  "src/agent/orchestrator/sales/salesRules.ts"
  "src/agent/orchestrator/sales/salesLogWriter.ts"
  "src/agent/orchestrator/sales/salesOrchestrator.ts"
  "src/agent/orchestrator/sales/runSalesFlowWithLogging.ts"

  "src/agent/orchestrator/sales/salesIntentDetector.test.ts"
  "src/agent/orchestrator/sales/salesStageMachine.test.ts"
  "src/agent/orchestrator/sales/salesOrchestrator.test.ts"
  "src/agent/orchestrator/sales/salesRules.test.ts"
  "tests/agent/rulesLoader.test.ts"
  "jest.config.cjs"

  "SCRIPTS/analyzeTemplateFallbacks.ts"
  "SCRIPTS/analyzeSalesKpiFunnel.ts"
  "SCRIPTS/convertTemplateMatrixCsvToJson.ts"
  "SCRIPTS/convertSalesLogsCsvToJson.ts"
  "SCRIPTS/run_template_fallback_report.sh"
  "SCRIPTS/run_sales_reports.sh"
  "SCRIPTS/setup_project_structure.sh"

  "data/template_matrix.csv"
  "data/template_matrix.json"
  "data/sales_logs.csv"
  "data/sales_logs.json"

  "reports/template_fallbacks_20251207.md"
  "reports/sales_kpi_funnel_20251207.md"

  "package.json"
  "pnpm-lock.yaml"
)

echo "[make_phase16_context] project root: $PROJECT_ROOT"
echo "[make_phase16_context] output zip:  $OUT_ZIP"
echo "[make_phase16_context] temp dir:    $TMP_DIR"

for pattern in "${INCLUDE_PATHS[@]}"; do
  # パターン展開（存在しない場合はそのまま文字列が残る）
  for path in $pattern; do
    if [[ ! -e "$path" ]]; then
      echo "[warn] missing path (ignored): $path" >&2
      continue
    fi

    rel_dir="$(dirname "$path")"
    dest_dir="$TMP_DIR/$rel_dir"
    mkdir -p "$dest_dir"

    if [[ $DRY_RUN -eq 1 ]]; then
      echo "[dry-run] include: $path"
    else
      echo "[copy] $path"
      cp -R "$path" "$dest_dir/"
    fi
  done
done

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[make_phase16_context] dry-run finished. ZIP は作成していません。"
  exit 0
fi

cd "$TMP_DIR"
zip -r "$OUT_ZIP" . >/dev/null

echo "[make_phase16_context] done. wrote: $OUT_ZIP"