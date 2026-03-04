#!/usr/bin/env bash
#
# Phase15: Setup base project structure and config files for commerce-faq-tasks.
#
# Usage:
#   SCRIPTS/setup_project_structure.sh [--dry-run]
#
# - Ensures core directories exist (docs/, config/, src/agent/...).
# - Creates config/salesIntentRules.yaml with Phase15 sample rules if it does not exist.
# - Never overwrites existing files.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

DRY_RUN=false

print_usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run]

Options:
  --dry-run   Show what would be done, but do not actually create directories or files.
  -h, --help  Show this help message.

Description:
  Setup minimum project structure for commerce-faq-tasks (Phase15):

  - Ensure core directories:
      docs/
      config/
      src/agent/dialog/
      src/agent/orchestrator/sales/
      SCRIPTS/

  - Ensure config/salesIntentRules.yaml exists:
      If missing, create a Phase15-compatible sample YAML with basic propose/recommend/close rules.

  Existing files and directories are never overwritten.
EOF
}

log() {
  printf '[setup] %s\n' "$*" >&2
}

log_dry() {
  if [ "$DRY_RUN" = true ]; then
    printf '[setup][dry-run] %s\n' "$*" >&2
  else
    printf '[setup] %s\n' "$*" >&2
  fi
}

ensure_dir() {
  local dir="$1"
  if [ -d "$dir" ]; then
    log "dir exists: $dir"
    return 0
  fi

  log_dry "create dir: $dir"
  if [ "$DRY_RUN" = false ]; then
    mkdir -p "$dir"
  fi
}

ensure_sales_intent_rules() {
  local path="${ROOT_DIR}/config/salesIntentRules.yaml"

  if [ -f "$path" ]; then
    log "config exists, keep as-is: $path"
    return 0
  fi

  log_dry "create sample salesIntentRules.yaml at: $path"
  if [ "$DRY_RUN" = true ]; then
    return 0
  fi

  cat >"$path" <<'YAML'
# Phase15 sample rules for SalesFlow Intent detection.
# This file is safe to edit and extend in each tenant/project.
#
# - Top-level keys: propose / recommend / close
# - Each entry:
#     intent: internal intent name (must match TypeScript union)
#     name:   human-readable label
#     weight: optional numeric weight (default 1.0)
#     patterns:
#       any:     keywords that contribute to score (hit count)
#       require: at least one of these must be present (OR condition), otherwise rule is ignored

propose:
  - intent: trial_lesson_offer
    name: "料金 → 体験レッスン案内"
    weight: 1.2
    patterns:
      any:
        - "料金"
        - "値段"
        - "体験レッスン"
        - "体験"
        - "お試し"
      require:
        - "料金"
        - "値段"

  - intent: propose_monthly_plan_basic
    name: "料金・プラン案内（ベーシック）"
    weight: 1.0
    patterns:
      any:
        - "料金"
        - "値段"
        - "金額"
        - "月額"
        - "月謝"
        - "プラン"
      require:
        - "料金"
        - "値段"
        - "金額"
        - "月額"

recommend:
  - intent: recommend_course_based_on_level
    name: "レベルに応じたコース提案"
    weight: 1.0
    patterns:
      any:
        - "自分に合うコース"
        - "どのコース"
        - "どのプラン"
        - "おすすめのコース"
        - "コース迷って"
        - "プラン迷って"
        - "レベル"
        - "初心者"
        - "久しぶり"
        - "ブランク"
      require:
        - "コース"
        - "プラン"
        - "レッスン"

close:
  - intent: close_handle_objection_price
    name: "料金に関する不安のハンドリング"
    weight: 1.2
    patterns:
      any:
        - "高い"
        - "ちょっと高い"
        - "料金が気になる"
        - "値段が気になる"
        - "金額が気になる"
        - "続けられるか心配"
        - "続けられるか不安"
      require:
        - "高い"
        - "料金"
        - "値段"
        - "金額"

  - intent: close_next_step_confirmation
    name: "次のステップ確認"
    weight: 1.0
    patterns:
      any:
        - "次のステップ"
        - "どう進める"
        - "どう始める"
        - "申し込みたい"
        - "入会したい"
      require:
        - "次のステップ"
        - "申し込みたい"
        - "入会したい"
YAML
}

main() {
  # Parse args
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      -h|--help)
        print_usage
        exit 0
        ;;
      *)
        printf 'Unknown option: %s\n\n' "$1" >&2
        print_usage
        exit 1
        ;;
    esac
  done

  log "project root: ${ROOT_DIR}"
  if [ ! -f "${ROOT_DIR}/README_PROJECT.md" ]; then
    log "warning: README_PROJECT.md not found in root; ensure ROOT_DIR is correct."
  fi

  # Ensure core directories
  ensure_dir "${ROOT_DIR}/docs"
  ensure_dir "${ROOT_DIR}/config"
  ensure_dir "${ROOT_DIR}/src/agent/dialog"
  ensure_dir "${ROOT_DIR}/src/agent/orchestrator/sales"
  ensure_dir "${ROOT_DIR}/SCRIPTS"

  # Ensure config files
  ensure_sales_intent_rules

  log "done."
}

main "$@"
