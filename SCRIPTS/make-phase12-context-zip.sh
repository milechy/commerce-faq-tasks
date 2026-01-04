#!/usr/bin/env bash
set -euo pipefail

# Phase12 用の開発コンテキスト ZIP を生成するスクリプト
# 使い方:
#   ./SCRIPTS/make-phase12-context-zip.sh
#   ./SCRIPTS/make-phase12-context-zip.sh my-phase12.zip

OUT_ZIP="${1:-phase12-context.zip}"

# スクリプトはリポジトリルート（README_PROJECT.md がある場所）で実行される想定
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[Phase12] creating context zip: ${OUT_ZIP}"
rm -f "${OUT_ZIP}"

# ====== ここに含めるファイル/ディレクトリ ======
# Phase12 では主に:
# - AgentDialogOrchestrator / LangGraphOrchestrator / CrewGraph 周辺
# - Planner 軽量化（ruleBasedPlanner）関連
# - ログ・パフォーマンス計測関連（analyze-agent-logs）
# - ドキュメント（README_PROJECT / ARCHITECTURE / AGENTS / REQUIREMENTS）
# を参照する前提でパスを選定している。

INCLUDE_PATHS=(
  # プロジェクトメタ / 要件 / アーキ / エージェント定義
  "README_PROJECT.md"
  "ARCHITECTURE.md"
  "AGENTS.md"
  "REQUIREMENTS.md"

  # パッケージ・TypeScript 設定（参照用）
  "package.json"
  "pnpm-lock.yaml"
  "tsconfig.json"

  # Agent HTTP 層 / Orchestrator
  "src/agent/http/AgentDialogOrchestrator.ts"
  "src/agent/http/agentDialogRoute.ts"
  "src/agent/http/agentDialogRoute.test.ts"

  # LangGraph Orchestrator / CrewGraph / CrewOrchestrator
  "src/agent/orchestrator/langGraphOrchestrator.ts"
  "src/agent/orchestrator/langGraphOrchestrator.test.ts"
  "src/agent/crew"

  # Planner / Search / Dialog types 周辺
  "src/agent/flow/queryPlanner.ts"
  "src/agent/flow/searchAgent.ts"
  "src/agent/flow/ruleBasedPlanner.ts"
  "src/agent/dialog/types.ts"

  # Phase12: Planner & Sales pipeline core
  "src/agent/flow/dialogOrchestrator.ts"
  "src/agent/types.ts"
  "src/agent/orchestrator/modelRouter.ts"
  "src/agent/orchestrator/sales/salesPipeline.ts"
  "src/agent/orchestrator/sales/kpiFunnel.ts"
  "src/agent/orchestrator/sales/pipelines/pipelineFactory.ts"

  # Phase12: LLM / Tools / RAG 周辺
  "src/agent/llm/groqClient.ts"
  "src/agent/llm/modelRouter.ts"
  "src/agent/llm/openaiEmbeddingClient.ts"
  "src/agent/tools/searchTool.ts"
  "src/agent/tools/rerankTool.ts"
  "src/agent/tools/synthesisTool.ts"
  "src/search/pgvectorSearch.ts"

  # ログ解析 / ベンチ系
  "src/SCRIPTS/analyze-agent-logs.ts"

  # その他、Phase12 で参照しそうな Agent 実装があればここに追加
  # 例: "src/agent/llm" "src/agent/tools"
)

# zip コマンドに渡すときに存在チェックしつつ追加
ZIP_ARGS=()
for path in "${INCLUDE_PATHS[@]}"; do
  if [ -e "$path" ]; then
    ZIP_ARGS+=("$path")
  else
    echo "  [warn] skip missing path: $path" >&2
  fi
done

if [ "${#ZIP_ARGS[@]}" -eq 0 ]; then
  echo "[error] no paths to include. abort." >&2
  exit 1
fi

zip -r "${OUT_ZIP}" "${ZIP_ARGS[@]}"

echo "[Phase12] done: ${OUT_ZIP}"
