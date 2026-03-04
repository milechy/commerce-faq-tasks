// src/agent/orchestrator/langGraphOrchestrator.test.ts
import "dotenv/config";
import assert from "node:assert/strict";

import { runDialogGraph } from "./langGraphOrchestrator";

async function test_langgraph_basic_flow() {
  // NOTE:
  // - 型定義に強く依存しないために any キャストを多用
  // - 目的は「例外を出さず、最低限の shape を満たすこと」のスモークテスト

  const input: any = {
    // DialogInput が期待するトップレベルのフィールド
    userMessage: "返品送料について教えてください",
    tenantId: "test-tenant",
    locale: "ja",
    conversationId: "test-session",
    // 旧インターフェース互換のためのフィールドも残しておく
    turn: {
      message: "返品送料について教えてください",
      sessionId: "test-session",
      options: {
        useMultiStepPlanner: false,
      },
    },
    history: [],
    meta: {
      route: "20b",
      plannerReasons: [],
      orchestratorMode: "langgraph",
      safetyTag: "none",
      requiresSafeMode: false,
      ragStats: {},
      graphVersion: "langgraph-v1",
      multiStepPlan: {},
      sessionId: "test-session",
    },
  };

  // runDialogGraph の正確なシグネチャに依存しないよう any 経由で呼ぶ
  const runForTest = runDialogGraph as unknown as (input: any) => Promise<any>;

  const out = await runForTest(input);

  assert.ok(out, "runDialogGraph should return a value");
  assert.equal(typeof out, "object", "output should be an object");

  const anyOut: any = out;

  // answer は string or null or undefined を許容（clarify の可能性もある）
  if (typeof anyOut.answer !== "undefined") {
    assert.ok(
      typeof anyOut.answer === "string" || anyOut.answer === null,
      "answer should be string or null when present"
    );
  }

  // steps があれば配列であること
  if (typeof anyOut.steps !== "undefined") {
    assert.ok(
      Array.isArray(anyOut.steps),
      "steps should be an array when present"
    );
  }

  // meta があれば object
  if (typeof anyOut.meta !== "undefined") {
    assert.equal(
      typeof anyOut.meta,
      "object",
      "meta should be an object when present"
    );
  }

  // graphVersion は存在すれば string
  if (typeof anyOut.graphVersion !== "undefined") {
    assert.equal(
      typeof anyOut.graphVersion,
      "string",
      "graphVersion should be string when present"
    );
  }
}

async function main() {
  console.log("Running LangGraph runtime tests...");
  let passed = 0;
  let failed = 0;

  try {
    await test_langgraph_basic_flow();
    console.log("✅ langgraph basic flow");
    passed++;
  } catch (err) {
    console.error("❌ langgraph basic flow");
    console.error(err);
    failed++;
  }

  console.log(
    "LangGraph runtime tests finished. passed=%d, failed=%d",
    passed,
    failed
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
