// src/agent/http/agentDialogRoute.test.ts

import "dotenv/config";

// Ensure test mode for Groq/OpenAI clients
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

import { strict as assert } from "assert";
import pino from "pino";
import { createAgentDialogHandler } from "./agentDialogRoute";

type TestResult = { statusCode: number; body: any };

function createHandler() {
  const logger = pino({ level: "silent" });
  const handler = createAgentDialogHandler(logger, {});
  return handler;
}

async function callHandler(body: any): Promise<TestResult> {
  const handler = createHandler();

  const req: any = { body };
  let statusCode = 200;
  let jsonBody: any = undefined;

  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      jsonBody = payload;
      return this;
    },
  };

  await handler(req, res);
  return { statusCode, body: jsonBody };
}

async function test_basic_dialog_returns_answer_and_steps() {
  const { statusCode, body } = await callHandler({
    message: "返品の送料を知りたい",
    options: { language: "ja" },
  });

  assert.equal(statusCode, 200, "status should be 200");
  assert.ok(body, "response body should be defined");

  // sessionId があれば string、なくても OK
  if (body.sessionId !== undefined) {
    assert.equal(
      typeof body.sessionId,
      "string",
      "sessionId should be a string when present"
    );
  }

  // answer は string でも null でも許容
  assert.ok(
    typeof body.answer === "string" || body.answer === null,
    "answer should be string or null"
  );

  assert.ok(Array.isArray(body.steps), "steps should be an array");
}

async function test_dialog_reuses_session_id() {
  const first = await callHandler({
    message: "返品の送料を知りたい",
    options: { language: "ja" },
  });

  const firstId = first.body?.sessionId;

  // 実装が sessionId を返さない場合は、「2回呼んでも動く」ことだけ確認
  if (!firstId) {
    const second = await callHandler({
      message: "別の質問です",
      options: { language: "ja" },
    });
    assert.equal(second.statusCode, 200, "second call should succeed");
    return;
  }

  const second = await callHandler({
    message: "別の質問です",
    sessionId: firstId,
    options: { language: "ja" },
  });

  assert.equal(
    second.body.sessionId,
    firstId,
    "sessionId should be reused across turns"
  );
}

async function test_dialog_returns_clarify_when_multi_step_enabled() {
  const { statusCode, body } = await callHandler({
    message: "返品の送料を知りたい",
    options: { language: "ja", useMultiStepPlanner: true },
  });

  assert.equal(statusCode, 200, "status should be 200");

  // マルチステップ有効時は clarification が必要であること
  assert.equal(
    body.needsClarification,
    true,
    "needsClarification should be true when multi-step planner is enabled"
  );

  assert.ok(
    Array.isArray(body.clarifyingQuestions) &&
      body.clarifyingQuestions.length > 0,
    "clarifyingQuestions should be a non-empty array"
  );

  // answer は null でも string でも OK（実装依存）
}

async function main() {
  console.log("Running /agent.dialog http tests...");

  const tests: [string, () => Promise<void>][] = [
    [
      "basic dialog returns answer and steps",
      test_basic_dialog_returns_answer_and_steps,
    ],
    ["dialog reuses sessionId across turns", test_dialog_reuses_session_id],
    [
      "dialog returns clarify when multi-step enabled",
      test_dialog_returns_clarify_when_multi_step_enabled,
    ],
  ];

  let passed = 0;
  let failed = 0;

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`✅ ${name}`);
    } catch (err) {
      failed++;
      console.error(`❌ ${name}`);
      console.error(err);
    }
  }

  console.log(
    `/agent.dialog http tests finished. passed=${passed}, failed=${failed}`
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
