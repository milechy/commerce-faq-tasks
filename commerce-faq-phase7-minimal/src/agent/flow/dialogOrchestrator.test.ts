// tests/agent/flow/dialogOrchestrator.test.ts

import { strict as assert } from 'node:assert'
import type { DialogMessage, MultiStepQueryPlan } from '../dialog/types'
import { runDialogOrchestrator } from './dialogOrchestrator'

async function test_clarify_branch() {
  const history: DialogMessage[] = []

  const plan: MultiStepQueryPlan = {
    // Orchestrator が見るのはこのあたりだけなので as any で十分
    steps: [
      {
        id: 'step_clarify_1',
        type: 'clarify',
        questions: ['どの商品についてですか？'],
      } as any,
    ],
    needsClarification: true,
    clarifyingQuestions: ['どの商品についてですか？'],
    followupQueries: [],
    confidence: 'medium',
    language: 'ja',
    raw: {},
  } as any

  const result = await runDialogOrchestrator({
    plan,
    sessionId: 'session-clarify',
    history,
  })

  assert.equal(
    result.needsClarification,
    true,
    'clarify branch should set needsClarification=true',
  )
  assert.deepEqual(
    result.clarifyingQuestions,
    ['どの商品についてですか？'],
    'clarifyingQuestions should be propagated',
  )
  assert(
    result.steps.some((s) => s.type === 'clarify_plan'),
    'steps should include a clarify_plan step',
  )
}

async function test_search_branch_with_search_step() {
  const history: DialogMessage[] = []

  const plan: MultiStepQueryPlan = {
    steps: [
      {
        id: 'step_search_1',
        type: 'search',
        query: '送料',
        topK: 3,
      } as any,
    ],
    needsClarification: false,
    clarifyingQuestions: [],
    followupQueries: [],
    confidence: 'medium',
    language: 'ja',
    raw: {},
  } as any

  const result = await runDialogOrchestrator({
    plan,
    sessionId: 'session-search',
    history,
    options: { topK: 3, debug: false },
  })

  assert.equal(
    result.needsClarification,
    false,
    'search branch should not set needsClarification',
  )
  assert.equal(result.final, true, 'search branch should mark final=true')
  assert(
    result.steps.some((s) => s.type === 'search_executed'),
    'steps should include a search_executed step',
  )
}

async function test_followup_queries_are_preferred() {
  const history: DialogMessage[] = []

  const plan: MultiStepQueryPlan = {
    steps: [
      {
        id: 'step_search_1',
        type: 'search',
        query: '送料',
        topK: 3,
      } as any,
    ],
    needsClarification: false,
    clarifyingQuestions: [],
    followupQueries: ['返品 ポリシー'],
    confidence: 'medium',
    language: 'ja',
    raw: {},
  } as any

  const result = await runDialogOrchestrator({
    plan,
    sessionId: 'session-followup',
    history,
    options: { topK: 5, debug: false },
  })

  const searchExecutedStep = result.steps.find(
    (s) => s.type === 'search_executed',
  ) as any

  assert(searchExecutedStep, 'search_executed step should exist')
  assert.equal(
    searchExecutedStep.query,
    '返品 ポリシー',
    'followupQueries[0] should be used as the primary query',
  )
}

async function main() {
  console.log('Running dialogOrchestrator flow tests...')

  const tests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'clarify branch', fn: test_clarify_branch },
    { name: 'search branch with search step', fn: test_search_branch_with_search_step },
    { name: 'followup queries are preferred', fn: test_followup_queries_are_preferred },
  ]

  let passed = 0
  let failed = 0

  for (const t of tests) {
    try {
      await t.fn()
      console.log(`✅ ${t.name}`)
      passed++
    } catch (err) {
      console.error(`❌ ${t.name}`)
      console.error(err)
      failed++
    }
  }

  console.log(
    `dialogOrchestrator flow tests finished. passed=${passed}, failed=${failed}`,
  )

  if (failed > 0) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main()
}