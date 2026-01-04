#!/usr/bin/env bash
set -euo pipefail

# このスクリプト自身の場所からプロジェクトルートへ
ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$ROOT_DIR"

OUT_ZIP="phase11-context.zip"

echo "🚀 Making Phase11 context zip at: $OUT_ZIP"
rm -f "$OUT_ZIP" || true

zip -r "$OUT_ZIP" \
  README.md \
  README_PHASE10.md \
  REQUIREMENTS.md \
  ARCHITECTURE.md \
  AGENTS.md \
  README_PROJECT.md \
  \
  package.json \
  pnpm-lock.yaml \
  tsconfig.json \
  .env.example \
  \
  src/index.ts \
  src/admin/http/faqAdminRoutes.ts \
  \
  src/agent/dialog/types.ts \
  \
  src/agent/http/agentDialogRoute.ts \
  src/agent/http/agentDialogRoute.test.ts \
  \
  src/agent/orchestrator/langGraphOrchestrator.ts \
  src/agent/orchestrator/sales \
  \
  src/agent/crew/CrewGraph.ts \
  src/agent/crew/nodes/PlannerNode.ts \
  src/agent/crew/nodes/KpiNode.ts \
  src/agent/crew/nodes/FinalNode.ts \
  src/agent/crew/nodes/InputNode.ts \
  \
  src/search \
  \
  commerce-faq-phase7-minimal/src/agent \
  commerce-faq-phase7-minimal/src/search \
  \
  tests/agent