#!/usr/bin/env bash
set -euo pipefail

# run_sales_reports.sh
#
# Phase15: SalesFlow 分析用のワンコマンドラッパ。
#
# やること:
#   1) TemplateMatrix CSV -> JSON
#   2) SalesLogs CSV      -> JSON
#   3) Template Fallback Analysis レポート生成
#   4) Sales KPI Funnel Analysis レポート生成
#
# Usage:
#   SCRIPTS/run_sales_reports.sh
#   SCRIPTS/run_sales_reports.sh --dry-run
#   SCRIPTS/run_sales_reports.sh \
#     --matrix-csv data/template_matrix.csv \
#     --logs-csv data/sales_logs.csv \
#     --out-dir reports
#
# Options:
#   --matrix-csv <path>   TemplateMatrix の CSV (default: data/template_matrix.csv)
#   --logs-csv <path>     SalesLogs の CSV (default: data/sales_logs.csv)
#   --out-dir <path>      レポート出力ディレクトリ (default: reports)
#   --date <YYYYMMDD>     レポートの日付サフィックス (default: `date +%Y%m%d`)
#   --dry-run             実行コマンドのみ表示
#   --help                このヘルプを表示

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MATRIX_CSV="data/template_matrix.csv"
LOGS_CSV="data/sales_logs.csv"
REPORT_DIR="reports"
REPORT_DATE="$(date +%Y%m%d)"
DRY_RUN=0

print_help() {
  cat <<EOF
Usage:
  SCRIPTS/run_sales_reports.sh [options]

Options:
  --matrix-csv <path>   TemplateMatrix の CSV (default: data/template_matrix.csv)
  --logs-csv <path>     SalesLogs の CSV (default: data/sales_logs.csv)
  --out-dir <path>      レポート出力ディレクトリ (default: reports)
  --date <YYYYMMDD>     レポートの日付サフィックス (default: today)
  --dry-run             実行コマンドのみ表示
  --help                このヘルプを表示
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --matrix-csv)
      MATRIX_CSV="$2"
      shift 2
      ;;
    --logs-csv)
      LOGS_CSV="$2"
      shift 2
      ;;
    --out-dir)
      REPORT_DIR="$2"
      shift 2
      ;;
    --date)
      REPORT_DATE="$2"
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
      echo "[run_sales_reports] unknown option: $1" >&2
      print_help
      exit 1
      ;;
  esac
done

MATRIX_JSON="data/template_matrix.json"
LOGS_JSON="data/sales_logs.json"

TEMPLATE_REPORT_BASENAME="template_fallbacks_${REPORT_DATE}.md"
KPI_REPORT_BASENAME="sales_kpi_funnel_${REPORT_DATE}.md"
TEMPLATE_REPORT_PATH="${REPORT_DIR}/${TEMPLATE_REPORT_BASENAME}"
KPI_REPORT_PATH="${REPORT_DIR}/${KPI_REPORT_BASENAME}"

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    echo "[run] $*"
    eval "$@"
  fi
}

cd "$ROOT_DIR"

echo "[run_sales_reports] project root: $ROOT_DIR"

echo "[run_sales_reports] matrix CSV: $MATRIX_CSV"
echo "[run_sales_reports] logs CSV:   $LOGS_CSV"
echo "[run_sales_reports] report dir: $REPORT_DIR"
echo "[run_sales_reports] report date: $REPORT_DATE"

if [[ "$DRY_RUN" -eq 0 ]]; then
  mkdir -p "$REPORT_DIR"
fi

# 1) TemplateMatrix CSV -> JSON
run_cmd "npx ts-node SCRIPTS/convertTemplateMatrixCsvToJson.ts --input \"$MATRIX_CSV\" --output \"$MATRIX_JSON\""

# 2) SalesLogs CSV -> JSON
run_cmd "npx ts-node SCRIPTS/convertSalesLogsCsvToJson.ts --input \"$LOGS_CSV\" --output \"$LOGS_JSON\""

# 3) Template Fallback Analysis (Markdown)
run_cmd "npx ts-node SCRIPTS/analyzeTemplateFallbacks.ts --matrix \"$MATRIX_JSON\" --logs \"$LOGS_JSON\" > \"$TEMPLATE_REPORT_PATH\""

# 4) Sales KPI Funnel Analysis (Markdown)
run_cmd "npx ts-node SCRIPTS/analyzeSalesKpiFunnel.ts --logs \"$LOGS_JSON\" > \"$KPI_REPORT_PATH\""

if [[ "$DRY_RUN" -eq 0 ]]; then
  echo "[run_sales_reports] template fallback report: $TEMPLATE_REPORT_PATH"
  echo "[run_sales_reports] KPI funnel report:       $KPI_REPORT_PATH"
else
  echo "[run_sales_reports] (dry-run: reports would be written to:"
  echo "  - $TEMPLATE_REPORT_PATH"
  echo "  - $KPI_REPORT_PATH)"
fi
