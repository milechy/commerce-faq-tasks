// tests/agent/queryPlanner.async.smoke.ts

import assert from 'node:assert/strict'
import { planQueryAsync } from '../../src/agent/flow/queryPlanner'

async function test_async_matches_sync_behavior() {
  const input = '返品したい場合の送料について教えて'
  const plan = await planQueryAsync(input, { topK: 8 })

  assert.equal(plan.searchQuery, '返品したい場合の送料')
  assert.equal(plan.topK, 8)
}

async function main() {
  try {
    await test_async_matches_sync_behavior()
    console.log('✅ async planner matches sync behavior')
    console.log('\nAll queryPlannerAsync tests passed 🎉')
  } catch (err) {
    console.error('❌ async planner test failed')
    console.error(String(err))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Unhandled error in queryPlannerAsync tests:', err)
  process.exit(1)
})