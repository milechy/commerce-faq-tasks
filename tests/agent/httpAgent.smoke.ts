// tests/agent/httpAgent.smoke.ts

import assert from 'node:assert/strict'

const BASE_URL = 'http://localhost:3000'

async function postAgent(body: unknown, init?: RequestInit) {
  const res = await fetch(`${BASE_URL}/agent.search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    body: JSON.stringify(body),
  })

  let json: any = null
  try {
    json = await res.json()
  } catch {
    // ignore parse error; json stays null
  }

  return { res, json }
}

async function test_ok_debug_true() {
  const { res, json } = await postAgent({
    q: '返品したい場合の送料について教えて',
    debug: true,
  })

  assert.equal(res.status, 200, `[ok_debug_true] expected 200, got ${res.status}`)

  assert.ok(json, '[ok_debug_true] response json should not be null')
  assert.ok(
    typeof json.answer === 'string' && json.answer.length > 0,
    '[ok_debug_true] answer should be non-empty string',
  )
  assert.ok(
    Array.isArray(json.steps),
    '[ok_debug_true] steps should be an array',
  )
  assert.ok(json.debug, '[ok_debug_true] debug should be defined')
}

async function test_ok_with_llm_planner() {
  const { res, json } = await postAgent({
    q: '返品したい場合の送料について教えて',
    debug: true,
    useLlmPlanner: true,
  })

  assert.equal(res.status, 200, `[ok_with_llm_planner] expected 200, got ${res.status}`)

  assert.ok(json, '[ok_with_llm_planner] response json should not be null')
  assert.ok(
    typeof json.answer === 'string' && json.answer.length > 0,
    '[ok_with_llm_planner] answer should be non-empty string',
  )
  assert.ok(
    Array.isArray(json.steps),
    '[ok_with_llm_planner] steps should be an array',
  )
  assert.ok(json.steps.length > 0 && json.steps[0].type === 'plan', '[ok_with_llm_planner] first step should have type "plan"')
  const msg = String(json.steps[0].message ?? '')
  assert.ok(
    msg.length > 0,
    '[ok_with_llm_planner] first step message should be a non-empty string',
  )
}

async function test_bad_request_missing_q() {
  const { res, json } = await postAgent({})

  assert.equal(res.status, 400, `[bad_request_missing_q] expected 400, got ${res.status}`)
  assert.ok(json, '[bad_request_missing_q] response json should not be null')
  assert.equal(
    json.error,
    'bad_request',
    `[bad_request_missing_q] error should be "bad_request" (got "${json.error}")`,
  )
}

async function test_bad_request_invalid_topK() {
  const { res, json } = await postAgent({
    q: '返品 送料',
    topK: 999,
  })

  assert.equal(res.status, 400, `[bad_request_invalid_topK] expected 400, got ${res.status}`)
  assert.ok(json, '[bad_request_invalid_topK] response json should not be null')
  assert.equal(
    json.error,
    'bad_request',
    `[bad_request_invalid_topK] error should be "bad_request" (got "${json.error}")`,
  )
}

async function main() {
  const tests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'ok_debug_true', fn: test_ok_debug_true },
    { name: 'bad_request_missing_q', fn: test_bad_request_missing_q },
    { name: 'bad_request_invalid_topK', fn: test_bad_request_invalid_topK },
    { name: 'ok_with_llm_planner', fn: test_ok_with_llm_planner },
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
    console.error(`\n${failed} httpAgent test(s) failed`)
    process.exit(1)
  } else {
    console.log('\nAll httpAgent tests passed 🎉')
  }
}

main().catch((err) => {
  console.error('Unhandled error in httpAgent tests:', err)
  process.exit(1)
})