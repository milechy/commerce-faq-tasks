#!/usr/bin/env bash
set -euo pipefail

# Template fallback report pipeline:
# 1) CSV (TemplateMatrix / SalesLogs) -> JSON
# 2) JSON -> Markdown report
#
# Usage:
#   SCRIPTS/run_template_fallback_report.sh
#   SCRIPTS/run_template_fallback_report.sh --matrix data/template_matrix.csv --logs data/sales_logs.csv
#   SCRIPTS/run_template_fallback_report.sh --dry-run
#
# Options:
#   --matrix <path>   Path to TemplateMatrix CSV (default: data/template_matrix.csv)
#   --logs <path>     Path to SalesLogs CSV (default: data/sales_logs.csv)
#   --out-dir <path>  Directory to write reports into (default: reports)
#   --dry-run         Show commands without executing
#   --help            Show this help

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MATRIX_CSV="data/template_matrix.csv"
LOGS_CSV="data/sales_logs.csv"
REPORT_DIR="reports"
DRY_RUN=0

print_help() {
  cat <<EOF
Usage:
  SCRIPTS/run_template_fallback_report.sh [options]

Options:
  --matrix <path>   Path to TemplateMatrix CSV (default: data/template_matrix.csv)
  --logs <path>     Path to SalesLogs CSV (default: data/sales_logs.csv)
  --out-dir <path>  Directory to write reports into (default: reports)
  --dry-run         Show commands without executing
  --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --matrix)
      MATRIX_CSV="$2"
      shift 2
      ;;
    --logs)
      LOGS_CSV="$2"
      shift 2
      ;;
    --out-dir)
      REPORT_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift 1
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "[run_template_fallback_report] unknown option: $1" >&2
      print_help
      exit 1
      ;;
  esac
done

MATRIX_JSON="data/template_matrix.json"
LOGS_JSON="data/sales_logs.json"

REPORT_BASENAME="template_fallbacks_$(date +%Y%m%d).md"
REPORT_PATH="${REPORT_DIR}/${REPORT_BASENAME}"

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    echo "[run] $*"
    eval "$@"
  fi
}

cd "$ROOT_DIR"

echo "[run_template_fallback_report] project root: $ROOT_DIR"
echo "[run_template_fallback_report] matrix CSV: $MATRIX_CSV"
echo "[run_template_fallback_report] logs CSV:   $LOGS_CSV"
echo "[run_template_fallback_report] report dir: $REPORT_DIR"

# Ensure report dir exists
if [[ "$DRY_RUN" -eq 0 ]]; then
  mkdir -p "$REPORT_DIR"
fi

# 1) CSV -> JSON
run_cmd "npx ts-node SCRIPTS/convertTemplateMatrixCsvToJson.ts --input \"$MATRIX_CSV\" --output \"$MATRIX_JSON\""
run_cmd "npx ts-node SCRIPTS/convertSalesLogsCsvToJson.ts --input \"$LOGS_CSV\" --output \"$LOGS_JSON\""

# 2) JSON -> Markdown report
run_cmd "npx ts-node SCRIPTS/analyzeTemplateFallbacks.ts --matrix \"$MATRIX_JSON\" --logs \"$LOGS_JSON\" > \"$REPORT_PATH\""

if [[ "$DRY_RUN" -eq 0 ]]; then
  echo "[run_template_fallback_report] report written to $REPORT_PATH"
else
  echo "[run_template_fallback_report] (dry-run: report would be written to $REPORT_PATH)"
fi