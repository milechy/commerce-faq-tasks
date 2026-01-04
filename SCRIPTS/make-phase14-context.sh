#!/usr/bin/env bash
set -euo pipefail

# phase14 コンテキスト ZIP を作るスクリプト
# 使い方:
#   ./SCRIPTS/make-phase14-context.sh         # 日付付きファイル名
#   ./SCRIPTS/make-phase14-context.sh 20251201  # 手動で日付を指定

DATE_SUFFIX="${1:-$(date +%Y%m%d)}"
OUT_FILE="phase14-context-${DATE_SUFFIX}.zip"

echo "[phase14-context] creating ${OUT_FILE} ..."

# 必須ファイル・ディレクトリ
INCLUDE_PATHS=(
  # プロジェクト全体
  "README_PROJECT.md"
  "REQUIREMENTS.md"
  "ARCHITECTURE.md"
  "AGENTS.md"

  # Phase13 ドキュメント
  "NOTION_SYNC.md"
  "TUNING_TEMPLATES_SPEC.md"
  "CLARIFY_FLOW.md"
  "CLARIFY_LOG_SPEC.md"
  "SALES_TEMPLATE_PROVIDER.md"
  "ENVIRONMENT.md"
  "PHASE13_SUMMARY.md"

  # エントリーポイント
  "src/index.ts"

  # Notion 連携
  "src/integrations/notion"

  # Sales / Clarify / テンプレ
  "src/agent/orchestrator/sales"

  # Repository 層
  "src/repositories"

  # Agent / Orchestrator 全体（SalesFlow統合用）
  "src/agent"

  # Notion sync スクリプト
  "SCRIPTS/sync-notion.ts"
)

# 既存ファイルがあれば削除
if [[ -f "${OUT_FILE}" ]]; then
  echo "[phase14-context] remove existing ${OUT_FILE}"
  rm -f "${OUT_FILE}"
fi

# zip コマンドでまとめる
# -r: 再帰
# -q: quiet（うるさかったら外してOK）
zip -r "${OUT_FILE}" "${INCLUDE_PATHS[@]}"

echo "[phase14-context] done -> ${OUT_FILE}"