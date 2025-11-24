// src/agent/http/agentDialogRoute.test.ts

import assert from 'node:assert/strict'

const BASE_URL = process.env.AGENT_BASE_URL ?? 'http://localhost:3000'

async function postDialog(body: unknown, init?: RequestInit) {
  const res = await fetch(`${BASE_URL}/agent.dialog`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    body: JSON.stringify(body),
  })

  let json: any = null
  try {
    json = await res.json()
  } catch {
    // ignore JSON parse error, let tests assert on json === null if needed
  }

  return { res, json }
}

async function test_basic_dialog_returns_answer_and_steps() {
  const { res, json } = await postDialog({
    message: '返品したい場合の送料について教えて',
  })

  assert.equal(
    res.status,
    200,
    `expected 200, got ${res.status} for /agent.dialog basic flow`,
  )

  // basic shape
  assert.ok(json, 'response JSON should not be null')
  assert.equal(typeof json.sessionId, 'string', 'sessionId should be a string')
  assert.ok(json.sessionId.length > 0, 'sessionId should not be empty')

  assert.ok(
    json.answer === null || typeof json.answer === 'string',
    'answer should be string or null',
  )

  assert.ok(Array.isArray(json.steps), 'steps should be an array')
  assert.ok(
    json.steps.length > 0,
    'steps array should not be empty for basic dialog',
  )

  assert.equal(
    typeof json.final,
    'boolean',
    'final should be a boolean in dialog response',
  )

  // meta / multiStepPlan は v1 でも最低限 presence を確認しておく
  assert.ok(json.meta, 'meta should exist on dialog response')
  assert.ok(
    json.meta.multiStepPlan,
    'meta.multiStepPlan should exist on dialog response',
  )
}

async function test_dialog_reuses_session_id() {
  const first = await postDialog({
    message: '配送について教えて',
  })

  assert.equal(
    first.res.status,
    200,
    `expected 200 for first dialog turn, got ${first.res.status}`,
  )

  const firstSessionId = first.json?.sessionId
  assert.equal(
    typeof firstSessionId,
    'string',
    'first sessionId should be a string',
  )

  const second = await postDialog({
    sessionId: firstSessionId,
    message: '北海道への送料は？',
  })

  assert.equal(
    second.res.status,
    200,
    `expected 200 for second dialog turn, got ${second.res.status}`,
  )

  const secondSessionId = second.json?.sessionId
  assert.equal(
    secondSessionId,
    firstSessionId,
    'sessionId should be echoed back and remain the same across turns',
  )
}

async function test_invalid_body_returns_400() {
  const { res, json } = await postDialog({})

  assert.equal(
    res.status,
    400,
    `expected 400 for invalid body, got ${res.status}`,
  )

  assert.ok(json, 'error response should have JSON body')
  assert.equal(
    json.error,
    'invalid_request',
    'error code for invalid body should be "invalid_request"',
  )
}

/**
 * useMultiStepPlanner を有効にしたときに、
 * 曖昧な問い合わせに対して Clarifying Question が返ってくることを検証する。
 */
async function test_dialog_returns_clarify_when_multi_step_enabled() {
  const { res, json } = await postDialog({
    message: '返品 送料',
    options: {
      useMultiStepPlanner: true,
    },
  })

  assert.equal(
    res.status,
    200,
    `expected 200 for clarify turn, got ${res.status}`,
  )

  assert.ok(json, 'response JSON should not be null')

  assert.equal(
    json.needsClarification,
    true,
    'needsClarification should be true for ambiguous query with multi-step enabled',
  )

  assert.ok(
    Array.isArray(json.clarifyingQuestions),
    'clarifyingQuestions should be an array when needsClarification is true',
  )
  assert.ok(
    json.clarifyingQuestions.length > 0,
    'clarifyingQuestions should not be empty',
  )

  assert.strictEqual(
    json.answer,
    null,
    'answer should be null when clarification is required and multi-step planner is enabled',
  )

  assert.equal(
    json.final,
    false,
    'final should be false when clarification is required',
  )
}

async function main() {
  const tests: { name: string; fn: () => Promise<void> }[] = [
    {
      name: 'basic dialog returns answer and steps',
      fn: test_basic_dialog_returns_answer_and_steps,
    },
    {
      name: 'dialog reuses sessionId across turns',
      fn: test_dialog_reuses_session_id,
    },
    {
      name: 'invalid body returns 400',
      fn: test_invalid_body_returns_400,
    },
    {
      name: 'dialog returns clarify when multi-step enabled',
      fn: test_dialog_returns_clarify_when_multi_step_enabled,
    },
  ]

  let passed = 0
  let failed = 0

  console.log('Running /agent.dialog http tests...\n')

  for (const t of tests) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await t.fn()
      passed++
      console.log(`✅ ${t.name}`)
    } catch (err) {
      failed++
      console.error(`❌ ${t.name}`)
      console.error(err)
    }
  }

  console.log(
    `\n/agent.dialog http tests finished. passed=${passed}, failed=${failed}`,
  )

  if (failed > 0) {
    console.error(`\n${failed} /agent.dialog http test(s) failed`)
    process.exit(1)
  } else {
    console.log('\nAll /agent.dialog http tests passed 🎉')
  }
}

main().catch((err) => {
  console.error('Unhandled error in /agent.dialog http tests:', err)
  process.exit(1)
})