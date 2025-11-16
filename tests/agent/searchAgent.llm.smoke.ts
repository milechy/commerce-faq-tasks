// tests/agent/searchAgent.llm.smoke.ts

import assert from 'node:assert/strict'
import { runSearchAgent } from '../../src/agent/flow/searchAgent'

async function test_basic_flow_with_llm_flag() {
  const q = '返品したい場合の送料について教えて'

  const result = await runSearchAgent({
    q,
    debug: true,
    useLlmPlanner: true,
  })

  // answer
  assert.ok(
    result.answer && result.answer.length > 0,
    '[llm_flag] answer should not be empty',
  )

  // steps
  assert.ok(Array.isArray(result.steps), '[llm_flag] steps should be an array')
  assert.ok(result.steps.length >= 3, '[llm_flag] steps length should be >= 3')

  const firstStep = result.steps[0]
  assert.equal(
    firstStep.type,
    'plan',
    `[llm_flag] first step type should be "plan" (got "${firstStep.type}")`,
  )

  // message が LLM Planner 向けに変わっていることだけ軽く確認
  assert.ok(
    typeof firstStep.message === 'string' &&
      firstStep.message.includes('LLM Planner'),
    '[llm_flag] plan step message should mention "LLM Planner"',
  )

  // debug
  assert.ok(result.debug, '[llm_flag] debug should be defined')
  assert.equal(
    result.debug.query.original,
    q,
    '[llm_flag] debug.query.original should match input q',
  )
}

async function main() {
  try {
    await test_basic_flow_with_llm_flag()
    console.log('✅ basic_flow_with_llm_flag')
    console.log('\nAll runSearchAgent LLM-flag tests passed 🎉')
  } catch (err) {
    console.error('❌ runSearchAgent LLM-flag test failed')
    console.error(String(err))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Unhandled error in runSearchAgent LLM-flag tests:', err)
  process.exit(1)
})