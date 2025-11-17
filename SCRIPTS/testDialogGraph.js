require('dotenv').config({ path: '.env.local' })
// SCRIPTS/testDialogGraph.js

// TypeScript ビルド済みの dist から Orchestrator を読み込む
const { runDialogGraph } = require('../dist/agent/orchestrator/langGraphOrchestrator')

async function main() {
  const output = await runDialogGraph({
    tenantId: 'demo',
    userMessage: '送料はいくらですか？',
    locale: 'ja',
    conversationId: 'test-local-1',
    history: [],
  })

  console.log('=== DialogGraph Output ===')
  console.log(JSON.stringify(output, null, 2))
}

main().catch((err) => {
  console.error('Error running dialog graph:', err)
  process.exit(1)
})