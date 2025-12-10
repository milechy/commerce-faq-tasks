// src/agent/flow/ruleBasedPlanner.test.ts

import "dotenv/config";
import assert from "node:assert/strict";

import { buildRuleBasedPlan } from "./ruleBasedPlanner";
import type { DialogInput } from "../orchestrator/langGraphOrchestrator";

function makeInput(
  message: string,
  history: DialogInput["history"] = [],
): DialogInput {
  return {
    tenantId: "test-tenant",
    userMessage: message,
    locale: "ja",
    conversationId: "test-conversation",
    history,
    historySummary: undefined,
  };
}

async function test_non_target_intent_returns_null() {
  const input = makeInput("送料を知りたいです");
  const plan = buildRuleBasedPlan(input, "general");

  assert.equal(plan, null);
}

async function test_shipping_needs_clarification_when_info_missing() {
  const input = makeInput("配送について教えてください");
  const plan = buildRuleBasedPlan(input, "shipping");

  assert.ok(plan, "plan should not be null");
  assert.equal(plan!.needsClarification, true);
  assert.ok(
    (plan!.clarifyingQuestions?.length ?? 0) > 0,
    "clarifyingQuestions should not be empty",
  );
}

async function test_shipping_falls_back_when_info_sufficient() {
  const input = makeInput(
    "この商品を東京に配送する場合の送料を知りたいです",
  );
  const plan = buildRuleBasedPlan(input, "shipping");

  assert.equal(
    plan,
    null,
    "when region and product look specified, rule-based planner should fall back to LLM planner",
  );
}

async function test_returns_needs_clarification_when_info_missing() {
  const input = makeInput("返品したいのですがどうすればいいですか？");
  const plan = buildRuleBasedPlan(input, "returns");

  assert.ok(plan, "plan should not be null");
  assert.equal(plan!.needsClarification, true);
  assert.ok(
    (plan!.clarifyingQuestions?.length ?? 0) > 0,
    "clarifyingQuestions should not be empty",
  );
}

async function test_returns_falls_back_when_info_sufficient() {
  const input = makeInput(
    "注文番号 ABCD1234 のイヤホンをサイズが合わなかったので返品したいです",
  );
  const plan = buildRuleBasedPlan(input, "returns");

  assert.equal(
    plan,
    null,
    "when orderId + item + reason look specified, rule-based planner should fall back to LLM planner",
  );
}

async function test_product_info_needs_clarification_when_info_missing() {
  const input = makeInput("サイズ感を知りたいです");
  const plan = buildRuleBasedPlan(input, "product-info");

  assert.ok(plan, "plan should not be null");
  assert.equal(plan!.needsClarification, true);
  assert.ok(
    (plan!.clarifyingQuestions?.length ?? 0) > 0,
    "clarifyingQuestions should not be empty",
  );
}

async function test_product_info_falls_back_when_info_sufficient() {
  const input = makeInput("ABC123のTシャツのサイズ感を教えてください");
  const plan = buildRuleBasedPlan(input, "product-info");

  assert.equal(
    plan,
    null,
    "when product + aspect look specified, rule-based planner should fall back to LLM planner",
  );
}

async function main() {
  const tests: Array<() => Promise<void>> = [
    test_non_target_intent_returns_null,
    test_shipping_needs_clarification_when_info_missing,
    test_shipping_falls_back_when_info_sufficient,
    test_returns_needs_clarification_when_info_missing,
    test_returns_falls_back_when_info_sufficient,
    test_product_info_needs_clarification_when_info_missing,
    test_product_info_falls_back_when_info_sufficient,
  ];

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    const name = t.name;
    try {
      await t();
      // eslint-disable-next-line no-console
      console.log("[ruleBasedPlanner.test] PASS:", name);
      passed++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[ruleBasedPlanner.test] FAIL:", name, err);
      failed++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    "[ruleBasedPlanner.test] finished. passed=%d, failed=%d",
    passed,
    failed,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});