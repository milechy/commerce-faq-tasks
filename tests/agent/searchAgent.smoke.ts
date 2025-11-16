// tests/agent/searchAgent.smoke.ts

import assert from 'node:assert/strict'
import { runSearchAgent } from '../../src/agent/flow/searchAgent'

async function test_basic_flow_debug_true() {
  const q = '返品したい場合の送料について教えて'

  const result = await runSearchAgent({ q, debug: true })

  // answer
  assert.ok(result.answer && result.answer.length > 0, '[debug:true] answer should not be empty')

  // steps
  assert.ok(Array.isArray(result.steps), '[debug:true] steps should be an array')
  assert.ok(result.steps.length >= 3, '[debug:true] steps length should be >= 3')

  const stepTypes = result.steps.map((s) => s.type)
  assert.equal(
    stepTypes[0],
    'plan',
    `[debug:true] first step type should be "plan" (got "${stepTypes[0]}")`,
  )
  assert.ok(
    stepTypes.includes('tool'),
    '[debug:true] steps should contain at least one "tool" step',
  )
  assert.ok(
    stepTypes.includes('synthesis'),
    '[debug:true] steps should contain a "synthesis" step',
  )

  // debug
  assert.ok(result.debug, '[debug:true] debug should be defined')
  assert.equal(
    result.debug.query.original,
    q,
    '[debug:true] debug.query.original should match input q',
  )
  assert.ok(
    result.debug.query.normalized && result.debug.query.normalized.length > 0,
    '[debug:true] debug.query.normalized should be non-empty',
  )
}

async function test_basic_flow_debug_false() {
  const q = '配送日時の指定について教えて'

  const result = await runSearchAgent({ q, debug: false })

  // answer
  assert.ok(result.answer && result.answer.length > 0, '[debug:false] answer should not be empty')

  // steps
  assert.ok(Array.isArray(result.steps), '[debug:false] steps should be an array')
  assert.ok(result.steps.length >= 3, '[debug:false] steps length should be >= 3')

  // debug ありだが中身は軽量なはず（実装により search/rerank が undefined になるケースも想定）
  assert.ok(result.debug, '[debug:false] debug should still exist')
  assert.equal(
    result.debug.query.original,
    q,
    '[debug:false] debug.query.original should match input q',
  )
}

async function main() {
  const tests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'basic_flow_debug_true', fn: test_basic_flow_debug_true },
    { name: 'basic_flow_debug_false', fn: test_basic_flow_debug_false },
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
    console.error(`\n${failed} runSearchAgent test(s) failed`)
    process.exit(1)
  } else {
    console.log('\nAll runSearchAgent tests passed 🎉')
  }
}

main().catch((err) => {
  console.error('Unhandled error in runSearchAgent tests:', err)
  process.exit(1)
})