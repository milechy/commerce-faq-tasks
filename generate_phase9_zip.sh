#!/bin/bash

set -e

ZIP_NAME="phase9-base.zip"

echo "Generating $ZIP_NAME ..."

# Remove old zip if exists
rm -f $ZIP_NAME

# Create zip with directory structure
zip -r $ZIP_NAME \
  src/agent/orchestrator/langGraphOrchestrator.ts \
  src/agent/orchestrator/modelRouter.ts \
  src/agent/orchestrator/sales/salesPipeline.ts \
  src/agent/orchestrator/sales/salesRules.ts \
  src/agent/crew/CrewAgent.ts \
  src/agent/crew/CrewTask.ts \
  src/agent/crew/CrewOrchestrator.ts \
  src/agent/dialog/types.ts \
  src/agent/http/agentDialogRoute.ts \
  src/agent/llm/openaiEmbeddingClient.ts \
  src/agent/llm/groqClient.ts \
  tests/agent/dialogGraph.smoke.ts \
  tests/agent/salesPipeline.test.ts \
  ARCHITECTURE.md \
  README_PROJECT.md \
  package.json \
  pnpm-lock.yaml

echo "Done!"
echo "Created: $ZIP_NAME"
