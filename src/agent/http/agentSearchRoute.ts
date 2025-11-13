import assert from 'assert';

async function test_ok_with_llm_planner() {
  // ... other test setup code ...

  // final assertion replaced as per instructions
  const msg = String(json.steps[0].message ?? '')
  assert.ok(
    msg.length > 0,
    '[ok_with_llm_planner] first step message should be a non-empty string',
  )
}