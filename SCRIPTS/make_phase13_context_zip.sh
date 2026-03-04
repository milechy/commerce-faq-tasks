#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Phase13 GPTコンテキスト用 Zip 生成スクリプト
# 実装リポジトリのルートで実行する想定
# ============================================

DATE_STR="$(date +%Y%m%d)"
OUTPUT_ZIP="phase13-context-${DATE_STR}.zip"

echo "📦 Generating Phase13 context zip: ${OUTPUT_ZIP}"
echo

# -----------------------------
# 1. 含めたいファイル/ディレクトリ一覧
#    必要に応じてここを編集する
# -----------------------------

FILES=(
  # ── ルートの基本情報 / ドキュメント ──
  "README.md"
  "ARCHITECTURE.md"
  "REQUIREMENTS.md"
  "AGENTS.md"
  "README_PROJECT.md"

  # ── Phase12 関連 docs ──
  "docs/PHASE12_SUMMARY.md"
  "docs/PLANNER_RULE_BASED.md"
  "docs/FAST_PATH_LOGIC.md"
  "docs/LOGGING_SCHEMA.md"
  "docs/P95_METRICS.md"
  "docs/AGENT_ORCHESTRATION.md"
  "docs/TESTCASE_PHASE12.md"
  "docs/TODO_PHASE13.md"

  # ── Notion 関連 docs（★今回追加） ──
  "docs/NOTION_OVERVIEW.md"
  "docs/NOTION_DB_SCHEMA.md"
  "docs/NOTION_PIPELINE.md"
  "docs/NOTION_SALES_FLOW.md"

  # ── API / RAG / DB などのベース仕様 ──
  "docs/API_AGENT.md "
  "docs/search-pipeline.md"
  "docs/db-schema.md"
  "docs/auth.md"
  "docs/tenant.md"

  # ── Agent / Planner / Orchestrator ──
  "src/agent/flow/ruleBasedPlanner.ts"
  "src/agent/flow/ruleBasedPlanner.test.ts"
  "src/agent/orchestrator/langGraphOrchestrator.ts"
  "src/agent/http/AgentDialogOrchestrator.ts"
  "src/agent/orchestrator/crew/crewSchemas.ts"
  "src/agent/orchestrator/crew/crewClient.ts"
  "src/agent/crew/CrewOrchestrator.ts"
  
  "src/agent/llm/modelRouter.ts"
  "src/agent/http/agentDialogRoute.ts"
  "src/agent/http/agentSearchRoute.ts"

  # ── ログ解析 / ベンチ ──
  "SCRIPTS/bench-agent-dialog.ts"
  "SCRIPTS/bench-agent-search.ts"
  "src/SCRIPTS/analyze-agent-logs.ts"

  # ── 依存関係・ビルド関連 ──
  "package.json"
  "pnpm-lock.yaml"
  "tsconfig.json"
)

# -----------------------------
# 2. 実在チェック＆警告
# -----------------------------

MISSING=()

echo "🔎 Checking listed files/directories..."
for path in "${FILES[@]}"; do
  if [[ -e "$path" ]]; then
    echo "  ✅ $path"
  else
    echo "  ⚠️  $path (NOT FOUND)"
    MISSING+=("$path")
  fi
done

echo

if ((${#MISSING[@]} > 0)); then
  echo "⚠️ 上記のうち存在しないパスがあります。Zip には含まれません。"
  echo "   不要なものは FILES 配列から削除しても OK です。"
  echo
fi

# -----------------------------
# 3. Zip 生成
# -----------------------------

# 既存ファイルがあれば退避 or 上書き確認してもよいが、
# ここでは素直に上書きする
if [[ -f "$OUTPUT_ZIP" ]]; then
  echo "🗑 既存の ${OUTPUT_ZIP} を削除します..."
  rm -f "$OUTPUT_ZIP"
fi

echo "📦 Zipping..."
zip -r "$OUTPUT_ZIP" "${FILES[@]}" >/dev/null

echo
echo "✅ Done! Created ${OUTPUT_ZIP}"
echo "   → 次の Phase13 チャットで、この Zip を最初にアップロードして使う想定です。"