// tests/agent/llm/modelRouter.test.ts

import { strict as assert } from 'node:assert'
import {
	routePlannerModel,
	type RouteContext,
} from '../../../src/agent/llm/modelRouter'

interface Case {
  name: string
  ctx: RouteContext
  expected: '20b' | '120b'
  forceEnv?: '20b' | '120b'
}

const baseCtx: RouteContext = {
  contextTokens: 1000,
  recall: 0.8,
  complexity: 'medium',
  safetyTag: 'none',
}

const cases: Case[] = [
  {
    name: 'default uses 20b',
    ctx: { ...baseCtx },
    expected: '20b',
  },
  {
    name: 'legal safetyTag forces 120b',
    ctx: { ...baseCtx, safetyTag: 'legal' },
    expected: '120b',
  },
  {
    name: 'high contextTokens uses 120b',
    ctx: { ...baseCtx, contextTokens: 3000 },
    expected: '120b',
  },
  {
    name: 'low recall uses 120b',
    ctx: { ...baseCtx, recall: 0.5 },
    expected: '120b',
  },
  {
    name: 'high complexity uses 120b',
    ctx: { ...baseCtx, complexity: 'high' },
    expected: '120b',
  },
  {
    name: 'LLM_FORCE_PLANNER_ROUTE=120b overrides everything',
    ctx: { ...baseCtx },
    expected: '120b',
    forceEnv: '120b',
  },
]

async function main() {
  console.log('Running routePlannerModel tests...')

  const originalForce = process.env.LLM_FORCE_PLANNER_ROUTE

  let passed = 0
  let failed = 0

  for (const c of cases) {
    try {
      if (typeof c.forceEnv !== 'undefined') {
        process.env.LLM_FORCE_PLANNER_ROUTE = c.forceEnv
      } else {
        delete process.env.LLM_FORCE_PLANNER_ROUTE
      }

      const result = routePlannerModel(c.ctx)

      assert.equal(
        result,
        c.expected,
        `${c.name}: expected ${c.expected} but got ${result}`,
      )

      console.log(`✅ ${c.name}`)
      passed++
    } catch (err) {
      console.error(`❌ ${c.name}`)
      console.error(err)
      failed++
    }
  }

  // restore env
  if (typeof originalForce === 'string') {
    process.env.LLM_FORCE_PLANNER_ROUTE = originalForce
  } else {
    delete process.env.LLM_FORCE_PLANNER_ROUTE
  }

  console.log(
    `routePlannerModel tests finished. passed=${passed}, failed=${failed}`,
  )

  if (failed > 0) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main()
}