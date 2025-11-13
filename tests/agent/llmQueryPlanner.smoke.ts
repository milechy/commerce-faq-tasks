// tests/agent/llmQueryPlanner.smoke.ts

import assert from 'node:assert/strict'
import {
	LlmClient,
	LlmQueryPlanner,
	type PlanOptions,
} from '../../src/agent/flow/queryPlanner'
import type { QueryPlan } from '../../src/agent/types'

class MockLlmClient implements LlmClient {
  constructor(private readonly responder: (prompt: string) => string) {}

  async complete(prompt: string): Promise<string> {
    return this.responder(prompt)
  }
}

async function test_llm_plan_basic() {
  const client = new MockLlmClient(() => {
    return JSON.stringify({
      search_query: '返品 送料',
      top_k: 10,
      language: 'ja',
      filters: {
        category: 'returns',
        categories: ['returns', 'shipping'],
        must_terms: ['返品', '送料'],
      },
    })
  })

  const planner = new LlmQueryPlanner({ client, model: 'dummy' })

  const input = '返品したい場合の送料について教えて'
  const options: PlanOptions = { topK: 8 }

  const plan: QueryPlan = await planner.planAsync(input, options)

  assert.equal(plan.searchQuery, '返品 送料', '[llm_basic] searchQuery mismatch')
  assert.equal(plan.topK, 10, '[llm_basic] topK mismatch')
  assert.ok(plan.filters, '[llm_basic] filters should be defined')
  assert.equal(
    (plan.filters as any).category,
    'returns',
    '[llm_basic] filters.category mismatch',
  )
}

async function test_llm_plan_invalid_json_fallback() {
  // わざと壊れた JSON を返すクライアント
  const client = new MockLlmClient(() => 'not a json response')

  const planner = new LlmQueryPlanner({ client })

  const input = '返品したい場合の送料について教えて'
  const options: PlanOptions = { topK: 8 }

  const plan: QueryPlan = await planner.planAsync(input, options)

  // フォールバックとして Rule-based の結果になることを期待
  assert.equal(
    plan.searchQuery,
    '返品したい場合の送料',
    '[llm_invalid] searchQuery should fall back to rule-based normalization',
  )
  assert.equal(plan.topK, 8, '[llm_invalid] topK should fall back to options.topK')
}

async function main() {
  const tests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'llm_plan_basic', fn: test_llm_plan_basic },
    { name: 'llm_plan_invalid_json_fallback', fn: test_llm_plan_invalid_json_fallback },
  ]

  let failed = 0

  for (const t of tests) {
    try {
      await t.fn()
      console.log(`✅ ${t.name}`)
    } catch (err) {
      failed++
      console.error(`❌ ${t.name}`)
      console.error(String(err))
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} LlmQueryPlanner test(s) failed`)
    process.exit(1)
  } else {
    console.log('\nAll LlmQueryPlanner tests passed 🎉')
  }
}

main().catch((err) => {
  console.error('Unhandled error in LlmQueryPlanner tests:', err)
  process.exit(1)
})