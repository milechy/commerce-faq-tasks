// tests/agent/queryPlanner.smoke.ts

import assert from 'node:assert/strict'
import { planQuery } from '../../src/agent/flow/queryPlanner'

type Case = {
  name: string
  input: string
  topK?: number
  expectedQuery: string
  expectedTopK: number
}

const cases: Case[] = [
  {
    name: '日本語: 「〜について教えて」を削る',
    input: '返品したい場合の送料について教えて',
    expectedQuery: '返品したい場合の送料',
    expectedTopK: 8,
  },
  {
    name: '日本語: 「〜を教えてください」を削る',
    input: '配送日時の指定方法を教えてください',
    expectedQuery: '配送日時の指定方法',
    expectedTopK: 8,
  },
  {
    name: '末尾の？を削る',
    input: '返品について？',
    expectedQuery: '返品について',
    expectedTopK: 8,
  },
  {
    name: 'topK オプションが clamp される (上限)',
    input: '返品 送料',
    topK: 100,
    expectedQuery: '返品 送料',
    expectedTopK: 20,
  },
  {
    name: 'topK オプションが clamp される (下限)',
    input: '返品 送料',
    topK: 0,
    expectedQuery: '返品 送料',
    expectedTopK: 1,
  },
]

function runCase(c: Case) {
  const plan = planQuery(c.input, c.topK != null ? { topK: c.topK } : {})

  assert.equal(
    plan.searchQuery,
    c.expectedQuery,
    `[${c.name}] searchQuery mismatch: expected "${c.expectedQuery}", got "${plan.searchQuery}"`,
  )

  assert.equal(
    plan.topK,
    c.expectedTopK,
    `[${c.name}] topK mismatch: expected ${c.expectedTopK}, got ${plan.topK}`,
  )
}

function main() {
  let failed = 0

  for (const c of cases) {
    try {
      runCase(c)
      console.log(`✅ ${c.name}`)
    } catch (err) {
      failed++
      console.error(`❌ ${c.name}`)
      console.error(String(err))
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`)
    process.exit(1)
  } else {
    console.log('\nAll queryPlanner tests passed 🎉')
  }
}

main()