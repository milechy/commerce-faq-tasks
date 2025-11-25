

/**
 * Minimal smoke test for runDialogGraph (LangGraph).
 *
 * This does NOT mock LLM or search — it simply verifies
 * that runDialogGraph loads, executes, and returns output
 * with the required structure.
 *
 * Run via:
 *   pnpm test:agent:graph
 */

import assert from 'assert'
import { runDialogGraph, type DialogInput } from '../../src/agent/orchestrator/langGraphOrchestrator'

// A minimal mock input
const baseInput: DialogInput = {
  tenantId: 't1',
  userMessage: '送料はいくらですか？',
  locale: 'ja',
  conversationId: 'conv1',
  history: [],
}

async function main() {
  console.log('Running dialogGraph smoke test...')

  const out = await runDialogGraph(baseInput)

  assert.ok(out, 'should return DialogOutput')
  assert.ok(typeof out.text === 'string', 'text should be string')
  assert.ok(out.route === '20b' || out.route === '120b', 'route should be 20b or 120b')
  assert.ok(Array.isArray(out.plannerReasons), 'plannerReasons should exist')
  assert.ok(out.ragStats, 'ragStats should exist (search / rerank stats)')
  assert.ok(out.salesMeta, 'salesMeta should exist')
  assert.ok(typeof out.salesMeta === 'object', 'salesMeta should be object')

  // Enhanced Phase8 checks
  assert.ok(out.plannerPlan, 'plannerPlan should exist');
  assert.ok(Array.isArray(out.plannerPlan.steps), 'plannerPlan.steps should be array');
  assert.ok(out.plannerPlan.steps.length > 0, 'plannerPlan.steps should not be empty');

  // SalesMeta structure checks
  assert.ok(typeof out.salesMeta.upsellTriggered === 'boolean', 'salesMeta.upsellTriggered should be boolean');
  assert.ok(typeof out.salesMeta.ctaTriggered === 'boolean', 'salesMeta.ctaTriggered should be boolean');
  assert.ok(Array.isArray(out.salesMeta.notes), 'salesMeta.notes should be array');

  // Graph metadata checks
  assert.ok(out.graphVersion === 'langgraph-v1', 'graphVersion should be langgraph-v1');

  console.log('dialogGraph smoke test passed 🎉')
}

main().catch((err) => {
  console.error('dialogGraph smoke test FAILED ❌')
  console.error(err)
  process.exit(1)
})